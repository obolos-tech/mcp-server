/**
 * Obolos Marketplace API Client
 * Fetches API catalog from the Obolos marketplace backend
 */
import type { MarketplaceApi, MarketplaceListResponse, MarketplaceSearchResponse, CategoryResponse } from './types.js';
export declare class MarketplaceClient {
    private baseUrl;
    constructor(baseUrl: string);
    /**
     * List all marketplace APIs with optional category filter
     */
    listApis(options?: {
        category?: string;
        page?: number;
        limit?: number;
    }): Promise<MarketplaceListResponse>;
    /**
     * Search APIs by query, category, and sort order
     */
    searchApis(options: {
        query?: string;
        category?: string;
        sort?: 'popular' | 'newest' | 'price_asc' | 'price_desc';
        page?: number;
        limit?: number;
    }): Promise<MarketplaceSearchResponse>;
    /**
     * Get full details for a single API
     */
    getApiDetails(id: string): Promise<MarketplaceApi>;
    /**
     * List all available categories
     */
    getCategories(): Promise<CategoryResponse>;
    /**
     * Call an API via the Obolos proxy.
     * Handles the x402 payment flow: initial request → 402 → sign → retry.
     */
    callApi(apiId: string, options: {
        method?: string;
        body?: Record<string, unknown>;
        queryParams?: Record<string, string>;
        signPayment: (paymentRequired: any) => Promise<Record<string, string>>;
    }): Promise<{
        status: number;
        headers: Record<string, string>;
        body: unknown;
    }>;
}
