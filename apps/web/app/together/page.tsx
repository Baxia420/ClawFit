import Link from "next/link";
import {
  getPreviousCalendarDate,
  getZonedCalendarDate,
  isValidCalendarDate,
  TOGETHER_VIEWING_TIMEZONE,
} from "@clawfit/health-core";
import { fetchTogetherData, HealthApiError, type TogetherResponse } from "../../lib/api";
import { TogetherMemberPanel } from "../../components/TogetherMemberPanel";

export const dynamic = "force-dynamic";

interface TogetherPageProps {
  searchParams: Promise<{
    date?: string;
    days?: string;
  }>;
}

export default async function TogetherPage({ searchParams }: TogetherPageProps) {
  const params = await searchParams;
  const todayStr = getZonedCalendarDate(new Date(), TOGETHER_VIEWING_TIMEZONE);
  const selectedDate = params.date && isValidCalendarDate(params.date) ? params.date : todayStr;
  const days = params.days === "30" ? 30 : 7;
  const yesterdayStr = getPreviousCalendarDate(todayStr);

  let data: TogetherResponse | null = null;
  let errorStatus: number | null = null;
  let errorCode: string | null = null;
  let errorMessage: string | null = null;

  try {
    data = await fetchTogetherData({ date: selectedDate, days });
  } catch (err) {
    if (err instanceof HealthApiError) {
      errorStatus = err.status;
      errorCode = err.code ?? null;
      errorMessage = err.message;
    } else {
      errorStatus = 503;
      errorMessage = err instanceof Error ? err.message : "Service unavailable";
    }
  }

  if (errorStatus || !data) {
    // 1. Expired Authentication -> Sign In action
    if (errorStatus === 401) {
      return (
        <div className="page service-error">
          <header className="page-header compact">
            <div>
              <span className="kicker">HOUSEHOLD SHARED VIEW</span>
              <h1>Together<br /><em>overview.</em></h1>
            </div>
          </header>
          <section className="panel" role="alert">
            <div className="panel-title">
              <span>AUTHENTICATION</span>
              <strong>session expired</strong>
            </div>
            <div className="service-error-body">
              <p>Your session or authentication token has expired. Please sign in again to access the household dashboard.</p>
              <Link
                href="/auth/signin"
                className="quick-ask dark"
                style={{ display: "inline-block", padding: "12px 20px", textDecoration: "none" }}
              >
                SIGN IN AGAIN
              </Link>
            </div>
          </section>
        </div>
      );
    }

    // 2. Denied Access / No Household -> Return to Personal Dashboard
    if (errorStatus === 403 && errorCode === "NO_HOUSEHOLD") {
      return (
        <div className="page service-error">
          <header className="page-header compact">
            <div>
              <span className="kicker">HOUSEHOLD SHARED VIEW</span>
              <h1>Together<br /><em>overview.</em></h1>
            </div>
          </header>
          <section className="panel" role="alert">
            <div className="panel-title">
              <span>ACCESS NOTICE</span>
              <strong>no household assigned</strong>
            </div>
            <div className="service-error-body">
              <p>You are not currently assigned to an active household. Household membership is required to access the shared Together view.</p>
              <Link
                href="/"
                className="quick-ask dark"
                style={{ display: "inline-block", padding: "12px 20px", textDecoration: "none" }}
              >
                BACK TO DASHBOARD
              </Link>
            </div>
          </section>
        </div>
      );
    }

    // 3. Inactive Account
    if (errorStatus === 403 && errorCode === "INACTIVE_USER") {
      return (
        <div className="page service-error">
          <header className="page-header compact">
            <div>
              <span className="kicker">HOUSEHOLD SHARED VIEW</span>
              <h1>Together<br /><em>overview.</em></h1>
            </div>
          </header>
          <section className="panel" role="alert">
            <div className="panel-title">
              <span>ACCESS NOTICE</span>
              <strong>account inactive</strong>
            </div>
            <div className="service-error-body">
              <p>Your user account is inactive. Please contact your household administrator.</p>
              <Link
                href="/auth/signin"
                className="quick-ask dark"
                style={{ display: "inline-block", padding: "12px 20px", textDecoration: "none" }}
              >
                SWITCH ACCOUNT
              </Link>
            </div>
          </section>
        </div>
      );
    }

    // 4. Invalid Input Date or Range
    if (errorStatus === 400) {
      return (
        <div className="page service-error">
          <header className="page-header compact">
            <div>
              <span className="kicker">HOUSEHOLD SHARED VIEW</span>
              <h1>Together<br /><em>overview.</em></h1>
            </div>
          </header>
          <section className="panel" role="alert">
            <div className="panel-title">
              <span>INPUT ERROR</span>
              <strong>invalid calendar date or range</strong>
            </div>
            <div className="service-error-body">
              <p>The requested date or trend duration is not valid. Please select a valid calendar date.</p>
              <Link
                href="/together"
                className="quick-ask dark"
                style={{ display: "inline-block", padding: "12px 20px", textDecoration: "none" }}
              >
                RESET TO TODAY
              </Link>
            </div>
          </section>
        </div>
      );
    }

    // 5. General Service Error or Network Failure -> Retry
    return (
      <div className="page service-error">
        <header className="page-header compact">
          <div>
            <span className="kicker">HOUSEHOLD SHARED VIEW</span>
            <h1>Together<br /><em>overview.</em></h1>
          </div>
        </header>
        <section className="panel" role="alert">
          <div className="panel-title">
            <span>SERVICE NOTICE</span>
            <strong>temporarily unavailable</strong>
          </div>
          <div className="service-error-body">
            <p>{errorMessage || "Unable to load shared household data right now. Please check your connection or retry."}</p>
            <a
              href={`/together?date=${selectedDate}&days=${days}`}
              className="quick-ask dark"
              style={{ display: "inline-block", padding: "12px 20px", textDecoration: "none" }}
            >
              RETRY CONNECTION
            </a>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="page-header compact">
        <div>
          <span className="kicker">HOUSEHOLD SHARED VIEW &middot; {data.household.name}</span>
          <h1>Together<br /><em>overview.</em></h1>
        </div>
        <div className="header-code">
          DATE: {selectedDate}<br />
          MEMBERS: {data.members.length}<br />
          STATUS: AUTHORIZED READ-ONLY
        </div>
      </header>

      {/* Date & Range Controls Toolbar */}
      <div className="together-toolbar">
        <nav className="together-date-nav" aria-label="Date navigation">
          <Link
            href={`/together?date=${todayStr}&days=${days}`}
            className={`together-btn-date ${selectedDate === todayStr ? "active" : ""}`}
          >
            Today
          </Link>
          <Link
            href={`/together?date=${yesterdayStr}&days=${days}`}
            className={`together-btn-date ${selectedDate === yesterdayStr ? "active" : ""}`}
          >
            Yesterday
          </Link>
          <form method="GET" action="/together" className="together-date-form">
            <input type="hidden" name="days" value={days} />
            <label htmlFor="together-date-picker" className="visually-hidden">
              Select date
            </label>
            <input
              id="together-date-picker"
              type="date"
              name="date"
              defaultValue={selectedDate}
              max={todayStr}
              className="together-date-input"
            />
            <button type="submit" className="together-date-submit">
              View
            </button>
          </form>
        </nav>

        <div className="range-switch" aria-label="Trend duration">
          <Link
            href={`/together?date=${selectedDate}&days=7`}
            className={days === 7 ? "active" : ""}
          >
            7D
          </Link>
          <Link
            href={`/together?date=${selectedDate}&days=30`}
            className={days === 30 ? "active" : ""}
          >
            30D
          </Link>
        </div>
      </div>

      {/* Members Progress Grid */}
      <section className="together-grid" aria-label="Household members progress">
        {data.members.length === 0 ? (
          <div className="empty panel">
            <strong>No active household members found</strong>
            <span>Active members in your household will appear here.</span>
          </div>
        ) : (
          <>
            {data.members.map((member) => (
              <TogetherMemberPanel
                key={member.userId}
                member={member}
                timeZone={data.timezone}
                trendDays={days}
              />
            ))}
            {data.members.length === 1 && (
              <div className="together-member-card empty-partner-card">
                <header className="together-member-header">
                  <div className="together-member-identity">
                    <span className="member-avatar" aria-hidden="true">--</span>
                    <div>
                      <h2 className="together-member-name">Partner</h2>
                      <small className="together-member-sub">Household membership</small>
                    </div>
                  </div>
                </header>
                <div className="together-empty-partner" style={{ padding: "32px 24px", textAlign: "center" }}>
                  <p style={{ margin: "0 0 8px", font: "800 12px var(--font-mono)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                    No partner currently available
                  </p>
                  <p style={{ margin: 0, fontSize: "13px", color: "var(--muted)", lineHeight: 1.5 }}>
                    No active household partner is currently assigned or available to view.
                  </p>
                </div>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
