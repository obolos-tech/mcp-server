/**
 * Type definitions for the Obolos MCP Server
 */
export interface MarketplaceApi {
    id: string;
    name: string;
    slug: string | null;
    description: string;
    category: string;
    price_per_call: number;
    http_method: string;
    seller_name: string;
    total_calls: number;
    example_request: string | null;
    example_response: string | null;
    api_type: 'native' | 'external';
    average_rating: number | null;
    review_count: number;
    input_schema?: InputSchema | null;
    input_type?: string;
    response_type?: string;
    proxy_endpoint?: string;
    resource_url?: string;
}
export interface InputSchema {
    method: string;
    bodyType: string;
    fields: Record<string, FieldSchema>;
    exampleResponse?: unknown;
}
export interface FieldSchema {
    type: string;
    required?: boolean;
    example?: unknown;
    description?: string;
    enum?: string[];
}
export interface MarketplaceListResponse {
    apis: MarketplaceApi[];
    pagination: {
        page: number;
        limit: number;
        total: number;
        total_pages: number;
        has_next: boolean;
        has_prev: boolean;
    };
    timestamp: string;
}
export interface MarketplaceSearchResponse extends MarketplaceListResponse {
    query: string | null;
    category: string | null;
    sort: string;
}
export interface CategoryResponse {
    categories: Array<{
        name: string;
        count: number;
    }>;
    nativeCount: number;
    externalCount: number;
    count: number;
}
export interface PaymentRequiredResponse {
    x402Version: number;
    accepts: Array<{
        scheme: string;
        network: string;
        maxAmountRequired?: string;
        amount?: string;
        resource?: string;
        payTo: string;
        asset: string;
    }>;
    error?: string;
}
export type AcpJobStatus = 'open' | 'funded' | 'submitted' | 'completed' | 'rejected' | 'expired';
export interface AcpJob {
    id: string;
    chain_job_id: number | null;
    client_address: string;
    provider_address: string | null;
    evaluator_address: string;
    title: string;
    description: string;
    budget: string | null;
    status: AcpJobStatus;
    deliverable: string | null;
    reason: string | null;
    hook_address: string | null;
    expired_at: string | null;
    tx_hash: string | null;
    created_at: string;
    updated_at: string;
}
export interface AcpJobListResponse {
    jobs: AcpJob[];
    pagination: {
        page: number;
        limit: number;
        total: number;
        total_pages: number;
        has_next: boolean;
        has_prev: boolean;
    };
}
