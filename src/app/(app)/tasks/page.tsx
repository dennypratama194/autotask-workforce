import { Suspense } from "react";
import { TasksScreen } from "@/components/tasks";
import { PageSkeleton } from "@/components/ui/kit";

export default function TasksPage() {
  return <Suspense fallback={<PageSkeleton />}><TasksScreen /></Suspense>;
}
