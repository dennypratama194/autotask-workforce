import { Suspense } from "react";
import { notFound } from "next/navigation";
import { parseTaskRef } from "@/lib/domain/rules";
import { TaskRoute } from "@/components/task-detail";
import { TasksScreen } from "@/components/tasks";
import { PageSkeleton } from "@/components/ui/kit";

export default async function TaskPage({ params }: { params: Promise<{ number: string }> }) {
  const n = parseTaskRef((await params).number);
  if (n === null) notFound();
  return <Suspense fallback={<PageSkeleton />}><TaskRoute number={n} background={<TasksScreen />} /></Suspense>;
}
