import type { NextConfig } from "next";
import { normalizeBackendOrigin } from "./src/net/backend-origin";

normalizeBackendOrigin(process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080");

const config: NextConfig = { output: "export", reactStrictMode: true };
export default config;
