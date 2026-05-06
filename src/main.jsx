import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { DataSourceProvider } from './contexts/DataSourceContext.jsx'
import { FollowsProvider } from './contexts/FollowsContext.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <DataSourceProvider>
      <FollowsProvider>
        <App />
      </FollowsProvider>
    </DataSourceProvider>
  </StrictMode>,
)
