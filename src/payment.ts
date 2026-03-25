/**
 * x402 Payment Signing for MCP Server
 *
 * Signs x402 payment requests using a private key (no browser wallet needed).
 * Supports both v1 (exact) and v2 (x402x-router-settlement) payment schemes.
 */

import {
  createWalletClient,
  http,
  publicActions,
  formatUnits,
  keccak256,
  encodePacked,
  type WalletClient,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { base } from 'viem/chains';

const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const;
const USDC_ABI = [
  {
    inputs: [{ name: 'account', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

/**
 * Calculate the SettlementRouter commitment hash.
 * This must be used as the EIP-3009 nonce when signing for router settlement,
 * because the on-chain contract recalculates and verifies it.
 */
function calculateCommitment(params: {
  chainId: bigint;
  hub: string;       // settlementRouter address
  asset: string;     // token (USDC) address
  from: string;      // payer address
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  salt: string;
  payTo: string;     // finalPayTo
  facilitatorFee: bigint;
  hook: string;
  hookData: string;
}): `0x${string}` {
  return keccak256(
    encodePacked(
      [
        'string',   // protocol identifier
        'uint256',  // chainId
        'address',  // hub (settlementRouter)
        'address',  // token
        'address',  // from
        'uint256',  // value
        'uint256',  // validAfter
        'uint256',  // validBefore
        'bytes32',  // salt
        'address',  // payTo
        'uint256',  // facilitatorFee
        'address',  // hook
        'bytes32',  // keccak256(hookData)
      ],
      [
        'X402/settle/v1',
        params.chainId,
        params.hub as `0x${string}`,
        params.asset as `0x${string}`,
        params.from as `0x${string}`,
        params.value,
        params.validAfter,
        params.validBefore,
        params.salt as `0x${string}`,
        params.payTo as `0x${string}`,
        params.facilitatorFee,
        params.hook as `0x${string}`,
        keccak256(params.hookData as `0x${string}`),
      ],
    ),
  );
}

export class PaymentSigner {
  private account: PrivateKeyAccount;
  private client: WalletClient & PublicClient;

  constructor(privateKey: string) {
    if (!privateKey.startsWith('0x')) {
      privateKey = `0x${privateKey}`;
    }
    this.account = privateKeyToAccount(privateKey as `0x${string}`);
    this.client = createWalletClient({
      account: this.account,
      chain: base,
      transport: http(),
    }).extend(publicActions) as any;
  }

  get address(): string {
    return this.account.address;
  }

  /**
   * Get USDC balance for the signing wallet
   */
  async getUsdcBalance(): Promise<{ raw: bigint; formatted: string }> {
    const balance = await (this.client as any).readContract({
      address: USDC_ADDRESS,
      abi: USDC_ABI,
      functionName: 'balanceOf',
      args: [this.account.address],
    });
    return {
      raw: balance as bigint,
      formatted: formatUnits(balance as bigint, 6),
    };
  }

  /**
   * Sign an x402 payment request and return the payment headers.
   *
   * This handles the EIP-712 typed data signing that the x402 protocol requires.
   * Works with both v1 (exact scheme) and v2 format 402 responses.
   */
  async signPayment(paymentRequired: any): Promise<Record<string, string>> {
    // Extract payment details from the 402 response
    const accepts = paymentRequired.accepts;
    if (!accepts || accepts.length === 0) {
      throw new Error('No payment options in 402 response');
    }

    const requirement = accepts[0];
    const scheme = requirement.scheme || 'exact';
    const rawNetwork = requirement.network || 'base';
    // Normalize short network names to CAIP-2 format (e.g. "base" → "eip155:8453")
    const network = rawNetwork.startsWith('eip155:') ? rawNetwork : 'eip155:8453';
    const amount = requirement.maxAmountRequired || requirement.amount;
    const payTo = requirement.payTo;
    const asset = requirement.asset || USDC_ADDRESS;

    if (!amount || !payTo) {
      throw new Error('Missing amount or payTo in payment requirement');
    }

    // Check for x402x-router-settlement extension
    const settlementKey = 'x402x-router-settlement';
    const settlementExt = requirement.extra?.[settlementKey];
    const settlementInfo = settlementExt?.info;

    // Build EIP-712 typed data for the exact scheme
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 300); // 5 min
    const amountBigInt = BigInt(amount);

    // Use the token contract's EIP-712 domain (provided in the 402 response's extra field)
    const domain = {
      name: requirement.extra?.name || 'USD Coin',
      version: requirement.extra?.version || '2',
      chainId: 8453n,
      verifyingContract: asset as `0x${string}`,
    };

    const types = {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    };

    // Determine the nonce: commitment hash for router settlement, random otherwise
    let nonce: `0x${string}`;
    if (settlementInfo?.settlementRouter && settlementInfo?.salt) {
      // SettlementRouter requires nonce = commitment hash of all settlement params
      nonce = calculateCommitment({
        chainId: 8453n,
        hub: settlementInfo.settlementRouter,
        asset,
        from: this.account.address,
        value: amountBigInt,
        validAfter: 0n,
        validBefore: deadline,
        salt: settlementInfo.salt,
        payTo: settlementInfo.finalPayTo || payTo,
        facilitatorFee: BigInt(settlementInfo.facilitatorFee || '0'),
        hook: settlementInfo.hook,
        hookData: settlementInfo.hookData,
      });
    } else {
      // Standard exact scheme — random nonce
      const nonceBytes = new Uint8Array(32);
      crypto.getRandomValues(nonceBytes);
      nonce = `0x${Array.from(nonceBytes).map(b => b.toString(16).padStart(2, '0')).join('')}` as `0x${string}`;
    }

    const message = {
      from: this.account.address,
      to: payTo as `0x${string}`,
      value: amountBigInt,
      validAfter: 0n,
      validBefore: deadline,
      nonce,
    };

    const signature = await this.client.signTypedData({
      account: this.account,
      domain,
      types,
      primaryType: 'TransferWithAuthorization',
      message,
    });

    const authorization = {
      from: this.account.address,
      to: payTo,
      value: amount.toString(),
      validAfter: '0',
      validBefore: deadline.toString(),
      nonce,
    };

    // Build v2 payment payload (includes accepted + extensions for facilitator)
    if (paymentRequired.x402Version === 2) {
      const paymentPayload: Record<string, unknown> = {
        x402Version: 2,
        scheme,
        network,
        payload: { signature, authorization },
        // Echo back the accepted requirement so the proxy takes the v2 path
        accepted: {
          ...requirement,
          network,
        },
      };

      // Forward settlement extensions if present in the 402 response
      if (settlementExt) {
        paymentPayload.extensions = { [settlementKey]: settlementExt };
      }

      const encoded = Buffer.from(JSON.stringify(paymentPayload)).toString('base64');
      return { 'payment-signature': encoded };
    }

    // v1 fallback
    const paymentPayload = {
      x402Version: 1,
      scheme,
      network,
      payload: { signature, authorization },
    };
    const encoded = Buffer.from(JSON.stringify(paymentPayload)).toString('base64');
    return { 'x-payment': encoded };
  }
}
