import { OiHttpClient } from "@oi/api-client";

// In a real application, this would fetch from Firebase Auth
// For this frontend-only UI integration, returning an empty string triggers the backend's dev bypass
const getDevToken = async () => "";

// Use Next.js API proxy for local development
const API_BASE_URL = "/api";

export const apiClient = new OiHttpClient(API_BASE_URL, getDevToken);
