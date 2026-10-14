import Link from "next/link";
import { ExerciseDetail } from "../../../../components/ExerciseLibrary";
export const dynamic = "force-dynamic";
export default async function LibraryDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <div className="page training-page"><Link className="training-back-link" href="/workouts/library">← Exercise library</Link><ExerciseDetail id={id} /></div>;
}
