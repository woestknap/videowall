import { Component, StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/roboto/400.css'
import '@fontsource/roboto/700.css'
import '@fontsource/space-grotesk/400.css'
import '@fontsource/space-grotesk/700.css'
import '@fontsource/source-serif-4/400.css'
import '@fontsource/jetbrains-mono/400.css'
import App from './App'
import './styles.css'

class CrashBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null }
  static getDerivedStateFromError(error: unknown) { return { error: error instanceof Error ? error.message : String(error) } }
  render() {
    if (this.state.error) return <main style={{ minHeight: '100vh', padding: '2rem', color: '#fff', background: '#111', fontFamily: 'monospace' }}><h1>Videowall player error</h1><pre>{this.state.error}</pre><p>Reload this Pi once. If this remains, send a photo of this message.</p></main>
    return this.props.children
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <CrashBoundary><App /></CrashBoundary>
  </StrictMode>,
)
