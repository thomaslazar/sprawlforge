import { Component, StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/App'
import { t } from './app/strings'

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 24, fontFamily: 'system-ui, sans-serif' }}>
          <h1 style={{ fontSize: 18 }}>{t.crash.title}</h1>
          <p>{t.crash.hint}</p>
          <pre style={{ whiteSpace: 'pre-wrap', opacity: 0.7 }}>{String(this.state.error)}</pre>
        </div>
      )
    }
    return this.props.children
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
