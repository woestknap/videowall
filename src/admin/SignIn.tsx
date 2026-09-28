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
  return <main className="pairing screenmesh-light-preview"><div className="sign-in-stack"><form className="sign-in-card sm-card" onSubmit={signIn}><p className="eyebrow">PERSONAL DISPLAY CONTROL</p><h1>ScreenMesh</h1><p>Sign in with your private administrator account.</p><label className="sm-field"><span>Email</span><input type="email" autoComplete="email" placeholder="you@example.com" value={email} onChange={(event) => setEmail(event.target.value)} required /></label><label className="sm-field"><span>Password</span><input type="password" autoComplete="current-password" placeholder="Enter your password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label><button className="sm-button" type="submit">Sign in</button><small className="sign-in-message" aria-live="polite">{message}</small></form><section className="conversion-tools sm-card-alt" aria-labelledby="conversion-tools-title"><p className="eyebrow">LOCAL MEDIA PREPARATION</p><h2 id="conversion-tools-title">ScreenMesh conversion tools</h2><p>Convert videos locally into a playback format optimized for ScreenMesh and Raspberry Pi players. Your original files never leave your computer.</p><div><a className="sm-button sm-button-secondary" href="/downloads/ScreenMesh-Convert-Windows.zip" download>Download for Windows</a><a className="sm-button sm-button-secondary" href="/downloads/ScreenMesh-Convert-macOS.command" download>Download for macOS</a></div></section></div></main>
}
