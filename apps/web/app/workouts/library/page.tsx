import Link from "next/link";
import { ExerciseLibrary } from "../../../components/ExerciseLibrary";
export const dynamic = "force-dynamic";
export default async function LibraryPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const query = await searchParams;
  return <div className="page training-page"><header className="page-header compact"><div><span className="kicker">CLAWFIT / TRAINING</span><h1>Exercise<br /><em>library.</em></h1></div><div className="header-code">BROWSE / LEARN<br />ADD TO YOUR PLAN</div></header><nav className="training-tabs" aria-label="Training sections"><Link href="/workouts">Train</Link><Link href="/workouts?tab=plans">Plans</Link><Link href="/workouts?tab=stats">Stats</Link><Link href="/workouts?tab=weight">Body weight</Link><Link href="/workouts/library" aria-current="page">Exercises</Link></nav><ExerciseLibrary initialQuery={query.q?.slice(0,160) ?? ""} /></div>;
}
