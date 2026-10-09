import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    unoptimized: true,
  },
  // PDFKit loads Helvetica through a package import (#standard-fonts/Helvetica).
  // Bundling it on Vercel drops that map, so the proof route must keep the real package.
  serverExternalPackages: ["pdfkit"],
  outputFileTracingIncludes: {
    "/api/upload-ai-design/submit": [
      "./node_modules/pdfkit/package.json",
      "./node_modules/pdfkit/js/standard-fonts/**/*",
    ],
  },
};

export default nextConfig;
