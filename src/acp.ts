/**
 * ACP (ERC-8183 Agentic Commerce Protocol) on-chain client for MCP Server
 *
 * Provides contract interaction for creating, funding, submitting,
 * completing, and rejecting jobs on the ACP smart contract on Base mainnet.
 */

import {
  createWalletClient,
  http,
  parseUnits,
  keccak256,
  toHex,
  publicActions,
  decodeEventLog,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { base } from 'viem/chains';

const ACP_ADDRESS = '0xaF3148696242F7Fb74893DC47690e37950807362' as const;
const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const;
const USDC_DECIMALS = 6;
const ZERO_BYTES32 = '0x0000000000000000000000000000000000000000000000000000000000000000' as const;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

// ─── ABI (duplicated from src/abi/acp.ts — static data, separate package) ──

const ACP_ABI = [
  {
    type: 'function',
    name: 'createJob',
    inputs: [
      { name: 'provider', type: 'address' },
      { name: 'evaluator', type: 'address' },
      { name: 'expiredAt', type: 'uint256' },
      { name: 'description', type: 'string' },
      { name: 'hook', type: 'address' },
    ],
    outputs: [{ name: 'jobId', type: 'uint256' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'setProvider',
    inputs: [
      { name: 'jobId', type: 'uint256' },
      { name: 'provider', type: 'address' },
      { name: 'optParams', type: 'bytes' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'setBudget',
    inputs: [
      { name: 'jobId', type: 'uint256' },
      { name: 'amount', type: 'uint256' },
      { name: 'optParams', type: 'bytes' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'fund',
    inputs: [
      { name: 'jobId', type: 'uint256' },
      { name: 'expectedBudget', type: 'uint256' },
      { name: 'optParams', type: 'bytes' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'submit',
    inputs: [
      { name: 'jobId', type: 'uint256' },
      { name: 'deliverable', type: 'bytes32' },
      { name: 'optParams', type: 'bytes' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'complete',
    inputs: [
      { name: 'jobId', type: 'uint256' },
      { name: 'reason', type: 'bytes32' },
      { name: 'optParams', type: 'bytes' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'reject',
    inputs: [
      { name: 'jobId', type: 'uint256' },
      { name: 'reason', type: 'bytes32' },
      { name: 'optParams', type: 'bytes' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'claimRefund',
    inputs: [{ name: 'jobId', type: 'uint256' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'getJob',
    inputs: [{ name: 'jobId', type: 'uint256' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'client', type: 'address' },
          { name: 'provider', type: 'address' },
          { name: 'evaluator', type: 'address' },
          { name: 'description', type: 'string' },
          { name: 'budget', type: 'uint256' },
          { name: 'expiredAt', type: 'uint256' },
          { name: 'status', type: 'uint8' },
          { name: 'hook', type: 'address' },
          { name: 'deliverable', type: 'bytes32' },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getJobCount',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'event',
    name: 'JobCreated',
    inputs: [
      { name: 'jobId', type: 'uint256', indexed: true },
      { name: 'client', type: 'address', indexed: true },
      { name: 'provider', type: 'address', indexed: false },
      { name: 'evaluator', type: 'address', indexed: false },
      { name: 'expiredAt', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'JobFunded',
    inputs: [
      { name: 'jobId', type: 'uint256', indexed: true },
      { name: 'client', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'JobSubmitted',
    inputs: [
      { name: 'jobId', type: 'uint256', indexed: true },
      { name: 'provider', type: 'address', indexed: true },
      { name: 'deliverable', type: 'bytes32', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'JobCompleted',
    inputs: [
      { name: 'jobId', type: 'uint256', indexed: true },
      { name: 'evaluator', type: 'address', indexed: true },
      { name: 'reason', type: 'bytes32', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'JobRejected',
    inputs: [
      { name: 'jobId', type: 'uint256', indexed: true },
      { name: 'rejector', type: 'address', indexed: true },
      { name: 'reason', type: 'bytes32', indexed: false },
    ],
  },
] as const;

const ERC20_APPROVE_ABI = [
  {
    type: 'function',
    name: 'approve',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'allowance',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
] as const;

// ─── Status enum mapping ───────────────────────────────────────────────────

const STATUS_MAP: Record<number, string> = {
  0: 'open',
  1: 'funded',
  2: 'submitted',
  3: 'completed',
  4: 'rejected',
};

// ─── Helpers ───────────────────────────────────────────────────────────────

function hashToBytes32(input: string | undefined): `0x${string}` {
  if (!input) return ZERO_BYTES32;
  return keccak256(toHex(input));
}

// ─── ACPClient ─────────────────────────────────────────────────────────────

export class ACPClient {
  private account: PrivateKeyAccount;
  private client;

  constructor(privateKey: string) {
    if (!privateKey.startsWith('0x')) {
      privateKey = `0x${privateKey}`;
    }
    this.account = privateKeyToAccount(privateKey as `0x${string}`);
    // Single client with both wallet and public actions (same pattern as payment.ts)
    this.client = createWalletClient({
      account: this.account,
      chain: base,
      transport: http(),
    }).extend(publicActions);
  }

  get address(): string {
    return this.account.address;
  }

  /**
   * Create a job on-chain.
   * Returns the jobId from the JobCreated event and the transaction hash.
   */
  async createJob(params: {
    provider: string;
    evaluator: string;
    expiredAt: number;
    description: string;
    hook: string;
  }): Promise<{ jobId: bigint; txHash: string }> {
    const txHash = await this.client.writeContract({
      address: ACP_ADDRESS,
      abi: ACP_ABI,
      functionName: 'createJob',
      args: [
        (params.provider || ZERO_ADDRESS) as `0x${string}`,
        params.evaluator as `0x${string}`,
        BigInt(params.expiredAt),
        params.description,
        (params.hook || ZERO_ADDRESS) as `0x${string}`,
      ],
      account: this.account,
      chain: base,
    });

    const receipt = await this.client.waitForTransactionReceipt({ hash: txHash });

    // Extract jobId from JobCreated event
    let jobId: bigint | undefined;
    for (const log of receipt.logs) {
      try {
        const decoded = decodeEventLog({
          abi: ACP_ABI,
          data: log.data,
          topics: log.topics,
        });
        if (decoded.eventName === 'JobCreated') {
          jobId = (decoded.args as any).jobId;
          break;
        }
      } catch {
        // Not our event, skip
      }
    }

    if (jobId === undefined) {
      throw new Error('JobCreated event not found in transaction receipt');
    }

    return { jobId, txHash };
  }

  /**
   * Approve USDC spend and fund the job escrow.
   */
  async fundJob(chainJobId: bigint, budgetUsdc: string): Promise<string> {
    const amount = parseUnits(budgetUsdc, USDC_DECIMALS);

    // 1. Check current allowance
    const allowance = await this.client.readContract({
      address: USDC_ADDRESS,
      abi: ERC20_APPROVE_ABI,
      functionName: 'allowance',
      args: [this.account.address, ACP_ADDRESS],
    });

    // 2. Approve if insufficient
    if ((allowance as bigint) < amount) {
      const approveTx = await this.client.writeContract({
        address: USDC_ADDRESS,
        abi: ERC20_APPROVE_ABI,
        functionName: 'approve',
        args: [ACP_ADDRESS, amount],
        account: this.account,
        chain: base,
      });
      await this.client.waitForTransactionReceipt({ hash: approveTx });
    }

    // 3. Fund the escrow
    const txHash = await this.client.writeContract({
      address: ACP_ADDRESS,
      abi: ACP_ABI,
      functionName: 'fund',
      args: [chainJobId, amount, '0x'],
      account: this.account,
      chain: base,
    });

    await this.client.waitForTransactionReceipt({ hash: txHash });
    return txHash;
  }

  /**
   * Submit work for a funded job. Hashes the deliverable string to bytes32.
   */
  async submitJob(chainJobId: bigint, deliverable: string): Promise<string> {
    const deliverableHash = hashToBytes32(deliverable);

    const txHash = await this.client.writeContract({
      address: ACP_ADDRESS,
      abi: ACP_ABI,
      functionName: 'submit',
      args: [chainJobId, deliverableHash, '0x'],
      account: this.account,
      chain: base,
    });

    await this.client.waitForTransactionReceipt({ hash: txHash });
    return txHash;
  }

  /**
   * Complete (approve) a submitted job. Releases payment to provider.
   */
  async completeJob(chainJobId: bigint, reason?: string): Promise<string> {
    const reasonHash = hashToBytes32(reason);

    const txHash = await this.client.writeContract({
      address: ACP_ADDRESS,
      abi: ACP_ABI,
      functionName: 'complete',
      args: [chainJobId, reasonHash, '0x'],
      account: this.account,
      chain: base,
    });

    await this.client.waitForTransactionReceipt({ hash: txHash });
    return txHash;
  }

  /**
   * Reject a submitted job. Refunds escrow to client.
   */
  async rejectJob(chainJobId: bigint, reason?: string): Promise<string> {
    const reasonHash = hashToBytes32(reason);

    const txHash = await this.client.writeContract({
      address: ACP_ADDRESS,
      abi: ACP_ABI,
      functionName: 'reject',
      args: [chainJobId, reasonHash, '0x'],
      account: this.account,
      chain: base,
    });

    await this.client.waitForTransactionReceipt({ hash: txHash });
    return txHash;
  }

  /**
   * Claim refund for an expired job.
   */
  async claimRefund(chainJobId: bigint): Promise<string> {
    const txHash = await this.client.writeContract({
      address: ACP_ADDRESS,
      abi: ACP_ABI,
      functionName: 'claimRefund',
      args: [chainJobId],
      account: this.account,
      chain: base,
    });

    await this.client.waitForTransactionReceipt({ hash: txHash });
    return txHash;
  }

  /**
   * Read job data from the chain.
   */
  async getJob(chainJobId: bigint): Promise<{
    client: string;
    provider: string;
    evaluator: string;
    description: string;
    budget: bigint;
    expiredAt: bigint;
    status: string;
    statusCode: number;
    hook: string;
    deliverable: string;
  }> {
    const result = await this.client.readContract({
      address: ACP_ADDRESS,
      abi: ACP_ABI,
      functionName: 'getJob',
      args: [chainJobId],
    }) as any;

    return {
      client: result.client,
      provider: result.provider,
      evaluator: result.evaluator,
      description: result.description,
      budget: result.budget,
      expiredAt: result.expiredAt,
      status: STATUS_MAP[Number(result.status)] || `unknown(${result.status})`,
      statusCode: Number(result.status),
      hook: result.hook,
      deliverable: result.deliverable,
    };
  }
}
