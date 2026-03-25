/**
 * x402 Payment Signing for MCP Server
 *
 * Signs x402 payment requests using a private key (no browser wallet needed).
 * Supports both v1 (exact) and v2 (x402x-router-settlement) payment schemes.
 */
export declare class PaymentSigner {
    private account;
    private client;
    constructor(privateKey: string);
    get address(): string;
    /**
     * Get USDC balance for the signing wallet
     */
    getUsdcBalance(): Promise<{
        raw: bigint;
        formatted: string;
    }>;
    /**
     * Sign an x402 payment request and return the payment headers.
     *
     * This handles the EIP-712 typed data signing that the x402 protocol requires.
     * Works with both v1 (exact scheme) and v2 format 402 responses.
     */
    signPayment(paymentRequired: any): Promise<Record<string, string>>;
}
