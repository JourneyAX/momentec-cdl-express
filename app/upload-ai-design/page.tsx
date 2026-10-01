import type { Metadata } from "next";
import { UploadAiDesignModal } from "./UploadAiDesignModal";

export const metadata: Metadata = {
  title: "Upload your AI design",
  description: "Drag and drop your AI generated design and get production-ready mockups for approval within 24hrs at no charge.",
};

export default function UploadAiDesignPage() {
  return <UploadAiDesignModal />;
}
