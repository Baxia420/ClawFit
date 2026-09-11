"use client";

import { useEffect } from "react";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("[CLAWFIT_PAGE] render failed", error);
  }, [error]);

  return <div className="page service-error">
    <header className="page-header compact"><div><span className="kicker">SERVICE STATUS</span><h1>Signal<br /><em>interrupted.</em></h1></div></header>
    <section className="panel"><div className="panel-title"><span>SERVICE NOTICE</span><strong>temporarily unavailable</strong></div><div className="service-error-body"><p>ClawFit could not connect to the health service. Please check your connection or try again shortly.</p><button type="button" onClick={reset}>RETRY CONNECTION</button></div></section>
  </div>;
}
