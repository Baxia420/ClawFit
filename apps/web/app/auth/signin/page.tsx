import type { Metadata } from "next";
import { signIn } from "../../../auth";

export const metadata: Metadata = {
  title: "Sign In",
};

export default async function SignInPage(props: {
  searchParams: Promise<{ callbackUrl?: string; error?: string }>;
}) {
  const searchParams = await props.searchParams;
  const callbackUrl = searchParams.callbackUrl || "/";
  const isGoogleConfigured = Boolean(
    (process.env.AUTH_GOOGLE_ID || process.env.GOOGLE_CLIENT_ID) &&
    (process.env.AUTH_GOOGLE_SECRET || process.env.GOOGLE_CLIENT_SECRET),
  );

  return (
    <div className="auth-container">
      <div className="auth-card">
        <header className="auth-header">
          <span className="kicker">IDENTITY &amp; ACCESS // SYSTEM 04</span>
          <h1>CLAW<em>/</em>FIT</h1>
          <p className="auth-subtitle">Private household nutrition &amp; strength log</p>
        </header>

        <div className="auth-body">
          {!isGoogleConfigured && (
            <div className="auth-notice" role="status">
              <span className="notice-badge">DEVELOPMENT NOTICE</span>
              <strong>Google OAuth Not Configured</strong>
              <p>
                To enable Google Sign-In, configure <code>AUTH_GOOGLE_ID</code>,{" "}
                <code>AUTH_GOOGLE_SECRET</code>, <code>CLAWFIT_PRIMARY_GOOGLE_EMAIL</code>, and{" "}
                <code>CLAWFIT_PARTNER_GOOGLE_EMAIL</code> in your local environment.
              </p>
            </div>
          )}

          <div className="auth-action">
            <form
              action={async () => {
                "use server";
                await signIn("google", { redirectTo: callbackUrl });
              }}
            >
              <button
                type="submit"
                className="google-signin-btn"
                disabled={!isGoogleConfigured}
                aria-label="Sign in with Google"
              >
                <svg
                  className="google-icon"
                  width="18"
                  height="18"
                  viewBox="0 0 18 18"
                  xmlns="http://www.w3.org/2000/svg"
                  aria-hidden="true"
                >
                  <path
                    fill="#4285F4"
                    d="M17.64 9.2045c0-.6381-.0573-1.2518-.1636-1.8409H9v3.4814h4.8436c-.2086 1.125-.8427 2.0782-1.7959 2.7164v2.2581h2.9087c1.7018-1.5668 2.6836-3.874 2.6836-6.615z"
                  />
                  <path
                    fill="#34A853"
                    d="M9 18c2.43 0 4.4673-.806 5.9564-2.1805l-2.9087-2.2581c-.8059.54-1.8368.859-3.0477.859-2.344 0-4.3282-1.5831-5.036-3.7104H.9574v2.3318C2.4382 15.9832 5.4818 18 9 18z"
                  />
                  <path
                    fill="#FBBC05"
                    d="M3.964 10.71c-.18-.54-.2822-1.1168-.2822-1.71s.1023-1.17.2823-1.71V4.9582H.9573A8.9965 8.9965 0 0 0 0 9c0 1.4523.3477 2.8268.9573 4.0418L3.964 10.71z"
                  />
                  <path
                    fill="#EA4335"
                    d="M9 3.5795c1.3214 0 2.5077.4541 3.4405 1.346l2.5813-2.5814C13.4632.8918 11.426 0 9 0 5.4818 0 2.4382 2.0168.9573 4.9582L3.964 7.29C4.6718 5.1627 6.6559 3.5795 9 3.5795z"
                  />
                </svg>
                <span>Sign in with Google</span>
              </button>
            </form>
          </div>

          <div className="auth-policy-note">
            <span>RESTRICTED ACCESS</span>
            <p>
              Access is strictly restricted to authorized household accounts. Unapproved accounts will be
              denied access.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
