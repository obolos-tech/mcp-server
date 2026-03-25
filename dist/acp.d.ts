/**
 * ACP (ERC-8183 Agentic Commerce Protocol) on-chain client for MCP Server
 *
 * Provides contract interaction for creating, funding, submitting,
 * completing, and rejecting jobs on the ACP smart contract on Base mainnet.
 */
export declare class ACPClient {
    private account;
    private client;
    constructor(privateKey: string);
    get address(): string;
    /**
     * Create a job on-chain.
     * Returns the jobId from the JobCreated event and the transaction hash.
     */
    createJob(params: {
        provider: string;
        evaluator: string;
        expiredAt: number;
        description: string;
        hook: string;
    }): Promise<{
        jobId: bigint;
        txHash: string;
    }>;
    /**
     * Approve USDC spend and fund the job escrow.
     */
    fundJob(chainJobId: bigint, budgetUsdc: string): Promise<string>;
    /**
     * Submit work for a funded job. Hashes the deliverable string to bytes32.
     */
    submitJob(chainJobId: bigint, deliverable: string): Promise<string>;
    /**
     * Complete (approve) a submitted job. Releases payment to provider.
     */
    completeJob(chainJobId: bigint, reason?: string): Promise<string>;
    /**
     * Reject a submitted job. Refunds escrow to client.
     */
    rejectJob(chainJobId: bigint, reason?: string): Promise<string>;
    /**
     * Claim refund for an expired job.
     */
    claimRefund(chainJobId: bigint): Promise<string>;
    /**
     * Read job data from the chain.
     */
    getJob(chainJobId: bigint): Promise<{
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
    }>;
}
