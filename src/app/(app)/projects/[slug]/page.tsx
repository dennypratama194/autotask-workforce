import { ProjectScreen } from "@/components/screens";

export default async function ProjectPage({ params }: { params: Promise<{ slug: string }> }) {
  return <ProjectScreen slug={(await params).slug} />;
}
