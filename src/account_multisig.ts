'use strict';

import BN from 'bn.js';
import { Account } from './account';
import { Contract } from './contract';
import { Connection } from './connection';
import { parseNearAmount } from './utils/format';
import { PublicKey } from './utils/key_pair';
import { Action, addKey, deleteKey, deployContract, functionCall, functionCallAccessKey } from './transaction';
import { FinalExecutionOutcome } from './providers';
import { fetchJson } from './utils/web';

const NETWORK_ID = process.env.REACT_APP_NETWORK_ID || 'default'
const CONTRACT_HELPER_URL = process.env.CONTRACT_HELPER_URL || 'https://helper.testnet.near.org';

export const MULTISIG_STORAGE_KEY = '__multisigRequest'
export const MULTISIG_ALLOWANCE = new BN(process.env.MULTISIG_ALLOWANCE || parseNearAmount('1'));
export const MULTISIG_GAS = new BN(process.env.MULTISIG_GAS || '100000000000000');
export const MULTISIG_DEPOSIT = new BN('0');
export const MULTISIG_CHANGE_METHODS = ['add_request', 'add_request_and_confirm', 'delete_request', 'confirm'];
export const MULTISIG_VIEW_METHODS = ['get_request_nonce', 'list_request_ids'];
export const MULTISIG_CONFIRM_METHODS = ['confirm'];

/********************************
This method can be used to mod a near instance .account helper to return AccountMultisig if the account has multisig deployed
It takes an options object where you can provide callbacks for:
- sendCode: how to send the 2FA code in case you don't use NEAR Contract Helper
- getCode: how to get code from user (use this to provide custom UI/UX for prompt of 2FA code)
- onResult: the tx result after it's been confirmed by NEAR Contract Helper
********************************/
export const modIfMultisig = (near, options) => {
    near.account = async (accountId) => {
        const account = new Account(near.connection, accountId);
        await account.state();
        const localKey = (await near.connection.signer.getPublicKey(account.accountId, near.connection.networkId)).toString();
        const accessKeys = await account.getAccessKeys();

        const hasFAK = accessKeys.find((k) => 
            k.public_key === localKey &&
            k.access_key.permission &&
            k.access_key.permission === 'FullAccess'
        );
        
        if (hasFAK) {
            return account;
        }
        
        const use2fa = accessKeys.find((k) => 
            k.public_key === localKey &&
            k.access_key.permission && 
            k.access_key.permission.FunctionCall &&
            k.access_key.permission.FunctionCall.method_names.some((mn) => MULTISIG_CHANGE_METHODS.includes(mn))
        );

        if (use2fa) {
            return new AccountMultisig(near.connection, accountId, options);
        }

        throw new Error(`Account ${accountId} doesn't have full access keys or multisig enabled`);
    };
    return near;
}

interface MultisigContract {
    get_request_nonce(): any,
    list_request_ids(): any,
    delete_request({ request_id: Number }): any,
};

type sendCodeFunction = () => Promise<any>;
type getCodeFunction = (method: any) => Promise<string>;
type verifyCodeFunction = (securityCode: any) => Promise<any>;

// in memory request cache for node w/o localStorage
let storageFallback = {
    [MULTISIG_STORAGE_KEY]: null
}

export class AccountMultisig extends Account {
    public contract: MultisigContract;
    public storage: any;
    public sendCode: sendCodeFunction;
    public getCode: getCodeFunction;
    public verifyCode: verifyCodeFunction;
    public onResult: Function;

    constructor(connection: Connection, accountId: string, options: any) {
        super(connection, accountId);
        this.storage = options.storage;
        this.sendCode = options.sendCode || this.sendCodeDefault;
        this.getCode = options.getCode || this.getCodeDefault;
        this.verifyCode = options.verifyCode || this.verifyCodeDefault;
        this.onResult = options.onResult;
        this.contract = <MultisigContract>getContract(this);
    }

    async addKey(publicKey: string | PublicKey, contractId?: string, methodName?: string, amount?: BN): Promise<FinalExecutionOutcome> {
        if (contractId) {
            return super.addKey(publicKey, contractId, MULTISIG_CHANGE_METHODS.join(), MULTISIG_ALLOWANCE)
        }
        return super.addKey(publicKey)
    }

    async signAndSendTransaction(receiverId: string, actions: Action[]): Promise<FinalExecutionOutcome> {
        const { accountId } = this;

        if (this.isDeleteAction(actions)) {
            return await super.signAndSendTransaction(accountId, actions)
        }
        await this.deleteUnconfirmedRequests()

        const requestId = await this.getRequestNonce()
        this.setRequest({ accountId, requestId, actions });

        const args = new Uint8Array(new TextEncoder().encode(JSON.stringify({
            request: {
                receiver_id: receiverId,
                actions: convertActions(actions, accountId, receiverId)
            }
        })));

        await super.signAndSendTransaction(accountId, [
            functionCall('add_request_and_confirm', args, MULTISIG_GAS, MULTISIG_DEPOSIT)
        ]);

        await this.sendCode();

        const result = await this.promptAndVerify();
        if (this.onResult) {
            this.onResult(result);
        }
        return result
    }

    async signAndSendTransactions(transactions) {
        for (let { receiverId, actions } of transactions) {
            await this.signAndSendTransaction(receiverId, actions)
        }
    }

    async deployMultisig(contractBytes: Uint8Array) {
        const { accountId } = this
        // replace account keys & recovery keys with limited access keys; DO NOT replace seed phrase keys
        const accountKeys = (await this.getAccessKeys()).map((ak) => ak.public_key)
        const seedPhraseKeys = (await this.getRecoveryMethods()).data
            .filter(({ kind, publicKey }) => kind === 'phrase' && publicKey !== null && accountKeys.includes(publicKey))
            .map((rm) => rm.publicKey)
        const fak2lak = accountKeys.filter((k) => !seedPhraseKeys.includes(k)).map(toPK)
        const confirmOnlyKey = toPK((await this.postSignedJson('/2fa/getAccessKey', { accountId })).publicKey)
        const newArgs = new Uint8Array(new TextEncoder().encode(JSON.stringify({ 'num_confirmations': 2 })));
        const actions = [
            ...fak2lak.map((pk) => deleteKey(pk)),
            ...fak2lak.map((pk) => addKey(pk, functionCallAccessKey(accountId, MULTISIG_CHANGE_METHODS, null))),
            addKey(confirmOnlyKey, functionCallAccessKey(accountId, MULTISIG_CONFIRM_METHODS, null)),
            deployContract(contractBytes),
            functionCall('new', newArgs, MULTISIG_GAS, MULTISIG_DEPOSIT),
        ]
        console.log('deploying multisig contract for', accountId)
        return await super.signAndSendTransaction(accountId, actions);
    }

    async deleteUnconfirmedRequests () {
        const { contract } = this
        const request_ids = await this.getRequestIds()
        for (const request_id of request_ids) {
            try {
                await contract.delete_request({ request_id })
            } catch(e) {
                console.warn("Attempt to delete an earlier request before 15 minutes failed. Will try again.")
            }
        }
    }

    // helpers

    async getRequestNonce(): Promise<Number> {
        return this.contract.get_request_nonce();
    }

    async getRequestIds(): Promise<string> {
        return this.contract.list_request_ids();
    }

    isDeleteAction(actions): Boolean {
        return actions && actions[0] && actions[0].functionCall && actions[0].functionCall.methodName === 'delete_request'
    }

    getRequest() {
        if (this.storage) {
            return JSON.parse(this.storage.getItem(MULTISIG_STORAGE_KEY) || `{}`)
        }
        return storageFallback[MULTISIG_STORAGE_KEY]
    }
    
    setRequest(data) {
        if (this.storage) {
            return this.storage.setItem(MULTISIG_STORAGE_KEY, JSON.stringify(data))
        }
        storageFallback[MULTISIG_STORAGE_KEY] = data
    }

    // default helpers for CH

    async sendCodeDefault() {
        const { accountId } = this;
        const { requestId, actions } = this.getRequest();
        if (this.isDeleteAction(actions)) {
            return
        }
        const method = await this.get2faMethod();
        await this.postSignedJson('/2fa/send', {
            accountId,
            method,
            requestId,
        });
        return requestId
    }

    async getCodeDefault(): Promise<string> {
        if (typeof window === 'undefined') {
            throw new Error('There is no getCodeFallback for Node env. Please provide your own in AccountMultisig constructor options argument.');
        }
        const method = await this.get2faMethod();
        if (!method || !method.kind) {
            throw new Error('no active 2fa method found');
        }
        const code = window.prompt(`Enter security code sent to ${ method.kind.split('2fa-')[1] }`)
        return code
    }

    async promptAndVerify() {
        const method = await this.get2faMethod();
        const securityCode = await this.getCode(method)
        try {
            const { success, res: result } = await this.verifyCode(securityCode);
            if (!success || result === false) {
                throw new Error('Request failed with error: ' + JSON.stringify(result));
            }
            return typeof result === 'string' && result.length === 0 ? 'true' : result;
        } catch (e) {
            console.warn('Invalid security code. Please try again.\n');
            return await this.promptAndVerify();
        }
    }

    async verifyCodeDefault(securityCode: string) {
        const { accountId } = this;
        const request = this.getRequest();
        if (!request) {
            throw new Error('no request pending')
        }
        const { requestId } = request
        return await this.postSignedJson('/2fa/verify', {
            accountId,
            securityCode,
            requestId
        });
    }

    async getRecoveryMethods() {
        const { accountId } = this
        return {
            accountId,
            data: await this.postSignedJson('/account/recoveryMethods', { accountId })
        }
    }

    async get2faMethod() {
        let { data } = await this.getRecoveryMethods()
        if (data && data.length) {
            data = data.find((m) => m.kind.indexOf('2fa-') === 0);
        }
        if (!data) return null
        const { kind, detail } = data;
        return { kind, detail };
    }

    async signatureFor() {
        const { accountId } = this;
        const blockNumber = String((await this.connection.provider.status()).sync_info.latest_block_height);
        const signed = await this.connection.signer.signMessage(Buffer.from(blockNumber), accountId, NETWORK_ID);
        const blockNumberSignature = Buffer.from(signed.signature).toString('base64');
        return { blockNumber, blockNumberSignature };
    }

    async postSignedJson(path, body) {
        return await fetchJson(CONTRACT_HELPER_URL + path, JSON.stringify({
            ...body,
            ...(await this.signatureFor())
        }));
    }
}

// helpers
const toPK = (pk) => PublicKey.from(pk)
const convertPKForContract = (pk) => pk.toString().replace('ed25519:', '');

const getContract = (account): unknown => {
    return new Contract(account, account.accountId, {
        viewMethods: MULTISIG_VIEW_METHODS,
        changeMethods: MULTISIG_CHANGE_METHODS,
    });
};

const convertActions = (actions, accountId, receiverId) => actions.map((a) => {
    const type = a.enum;
    const { gas, publicKey, methodName, args, deposit, accessKey, code } = a[type];
    const action = {
        type: type[0].toUpperCase() + type.substr(1),
        gas: (gas && gas.toString()) || undefined,
        public_key: (publicKey && convertPKForContract(publicKey)) || undefined,
        method_name: methodName,
        args: (args && Buffer.from(args).toString('base64')) || undefined,
        code: (code && Buffer.from(code).toString('base64')) || undefined,
        amount: (deposit && deposit.toString()) || undefined,
        deposit: (deposit && deposit.toString()) || '0',
        permission: undefined,
    };
    if (accessKey) {
        if (receiverId === accountId && accessKey.permission.enum !== 'fullAccess') {
            action.permission = {
                receiver_id: accountId,
                allowance: MULTISIG_ALLOWANCE.toString(),
                method_names: MULTISIG_CHANGE_METHODS,
            };
        }
        if (accessKey.permission.enum === 'functionCall') {
            const { receiverId: receiver_id, methodNames: method_names, allowance } = accessKey.permission.functionCall;
            action.permission = {
                receiver_id,
                allowance: (allowance && allowance.toString()) || undefined,
                method_names
            };
        }
    }
    return action;
});