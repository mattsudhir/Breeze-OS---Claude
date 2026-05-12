import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ClerkProvider } from '@clerk/clerk-react'
import './index.css'
import App from './App.jsx'
import { DataSourceProvider } from './contexts/DataSourceContext.jsx'
import { FollowsProvider } from './contexts/FollowsContext.jsx'

// Clerk wraps the app only when a publishable key is provided. The
// envelope is built so the existing deployment keeps working with
// no Clerk env vars set — flip Clerk on by populating
// VITE_CLERK_PUBLISHABLE_KEY (+ CLERK_SECRET_KEY on the server) in
// Vercel and redeploying.
const CLERK_PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

const inner = (
  <DataSourceProvider>
    <FollowsProvider>
      <App />
    </FollowsProvider>
  </DataSourceProvider>
);

const tree = CLERK_PUBLISHABLE_KEY ? (
  <ClerkProvider
    publishableKey={CLERK_PUBLISHABLE_KEY}
    signInForceRedirectUrl="/"
    signUpForceRedirectUrl="/"
    afterSignOutUrl="/"
  >
    {inner}
  </ClerkProvider>
) : inner;

createRoot(document.getElementById('root')).render(
  <StrictMode>{tree}</StrictMode>,
)
