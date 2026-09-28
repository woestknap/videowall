import { useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'

export function SignIn() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [message, setMessage] = useState('')
  async function signIn(event: FormEvent) {
    event.preventDefault(); if (!supabase) return
    setMessage('Signing in…')
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    setMessage(error ? error.message : 'Signed in.')
  }
  return <main className="pairing"><div className="sign-in-stack"><form onSubmit={signIn}><p className="eyebrow">PERSONAL DISPLAY CONTROL</p><h1>Videowall</h1><p>Sign in with your private administrator account.</p><input type="email" autoComplete="email" placeholder="you@example.com" value={email} onChange={(event) => setEmail(event.target.value)} required /><input type="password" autoComplete="current-password" placeholder="Password" value={password} onChange={(event) => setPassword(event.target.value)} required /><button>Sign in</button><small>{message}</small></form><section className="conversion-tools" aria-labelledby="conversion-tools-title"><p className="eyebrow">LOCAL MEDIA PREPARATION</p><h2 id="conversion-tools-title">ScreenMesh conversion tools</h2><p>Convert videos locally into a playback format optimized for ScreenMesh and Raspberry Pi players. Your original files never leave your computer.</p><div><a href="/downloads/ScreenMesh-Convert-Windows.zip" download>Download for Windows</a><a href="/downloads/ScreenMesh-Convert-macOS.command" download>Download for macOS</a></div></section></div></main>
}
