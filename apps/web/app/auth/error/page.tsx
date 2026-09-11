import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Authentication Error",
};

interface ErrorInfo {
  title: string;
  code: string;
  message: string;
  detail: string;
}

function resolveErrorDetails(error?: string): ErrorInfo {
  switch (error) {
    case "SessionExpired":
      return {
        title: "SESSION EXPIRED",
        code: "SESSION_EXPIRED",
        message: "Your sign-in session has expired.",
        detail: "Please sign in again to continue to your dashboard.",
      };
    case "ACCOUNT_MISMATCH":
      return {
        title: "ACCOUNT MISMATCH",
        code: "ACCOUNT_MISMATCH",
        message: "This Google account is linked to a different household profile.",
        detail: "Each household profile is securely paired to a specific Google account.",
      };
    case "IDENTITY_CONFLICT":
      return {
        title: "ACCOUNT CONFLICT",
        code: "IDENTITY_CONFLICT",
        message: "This account is already linked to another user.",
        detail: "Please sign in with your own designated Google account.",
      };
    case "UNAPPROVED_ACCOUNT":
      return {
        title: "ACCOUNT NOT AUTHORIZED",
        code: "UNAPPROVED_ACCOUNT",
        message: "This Google account is not on the ClawFit household allowlist.",
        detail:
          "ClawFit is a private system limited strictly to the primary and partner accounts configured by the household owner.",
      };
    case "INACTIVE_USER":
      return {
        title: "PROFILE INACTIVE",
        code: "INACTIVE_USER",
        message: "Your ClawFit user profile is currently inactive.",
        detail: "Health data access is disabled for inactive profiles. Please contact your household administrator.",
      };
    case "UNVERIFIED_EMAIL":
      return {
        title: "EMAIL NOT VERIFIED",
        code: "UNVERIFIED_EMAIL",
        message: "Your Google account email has not been verified.",
        detail: "For security, ClawFit requires a verified email address from Google before signing in.",
      };
    case "MissingProfileData":
      return {
        title: "MISSING PROFILE DATA",
        code: "MISSING_PROFILE_DATA",
        message: "Google did not provide the required profile identifier or email.",
        detail: "Ensure your Google account permits basic profile and email access when authenticating.",
      };
    case "ServiceUnavailable":
      return {
        title: "SERVICE UNAVAILABLE",
        code: "SERVICE_UNAVAILABLE",
        message: "The authentication service is temporarily unavailable.",
        detail: "Please check your connection or try again in a few moments.",
      };
    case "Configuration":
      return {
        title: "SETUP REQUIRED",
        code: "SETUP_REQUIRED",
        message: "Authentication is not yet configured for this deployment.",
        detail: "Please ensure required environment credentials are set up.",
      };
    case "AccessDenied":
    default:
      return {
        title: "ACCESS DENIED",
        code: error || "ACCESS_DENIED",
        message: "You do not have permission to access this dashboard.",
        detail: "Please verify you are signed in with an authorized household account.",
      };
  }
}

export default async function AuthErrorPage(props: {
  searchParams: Promise<{ error?: string }>;
}) {
  const searchParams = await props.searchParams;
  const info = resolveErrorDetails(searchParams.error);

  return (
    <div className="auth-container">
      <div className="auth-card error-card">
        <header className="auth-header">
          <span className="kicker error-kicker">ACCESS NOTICE // {info.code}</span>
          <h1 className="error-title">{info.title}</h1>
          <p className="auth-subtitle">{info.message}</p>
        </header>

        <div className="auth-body">
          <div className="error-detail-box">
            <p>{info.detail}</p>
          </div>

          <div className="auth-action">
            <Link href="/auth/signin" className="error-back-btn">
              RETURN TO SIGN IN
            </Link>
          </div>

          <div className="auth-policy-note">
            <span>AUDIT NOTICE</span>
            <p>
              Failed authentication attempts are logged for security. If you believe this is in error, verify
              the Google account you are currently logged into in your browser.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
