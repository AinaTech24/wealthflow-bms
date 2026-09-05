
import React, { useState } from 'react';
import { Mail, Lock, Key, ArrowRight, ShieldCheck, RefreshCw, CheckCircle, AlertCircle, Eye, EyeOff } from 'lucide-react';
import { Logo } from '../components/Logo';
import { TeamMember } from '../types';
import { useData } from '../contexts/DataContext';
import { useToast } from '../components/Toast';

interface LoginProps {
  onLogin: (user: TeamMember) => void;
}

type AuthView = 'LOGIN' | 'FORGOT' | 'OTP' | 'RESET';

export const Login: React.FC<LoginProps> = ({ onLogin }) => {
  const { team, isOnline, loading } = useData();
  const { showToast } = useToast();
  const [view, setView] = useState<AuthView>('LOGIN');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isAuthenticating, setIsAuthenticating] = useState(false);

  // Forgot Password States
  const [otp, setOtp] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const handleLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsAuthenticating(true);

    const identifier = email.trim().toLowerCase();
    const pass = password.trim();

    try {
      // 1. Try Server-Side Verification (More Secure)
      if (isOnline) {
        try {
          const controller = new AbortController();
          // Keep login responsive if backend auth hangs.
          const timeoutId = window.setTimeout(() => controller.abort(), 12000);
          let response: Response;
          try {
            response = await fetch('/api/data', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                action: 'auth',
                identifier: identifier,
                password: pass
              }),
              signal: controller.signal
            });
          } finally {
            window.clearTimeout(timeoutId);
          }

          const raw = await response.text();
          let data: any = {};
          if (raw) {
            try { data = JSON.parse(raw); } catch { data = {}; }
          }

          if (response.ok && data.success && data.user) {
            // Store JWT token
            if (data.token) {
              localStorage.setItem('wf_token', data.token);
              localStorage.setItem('wf_user', JSON.stringify(data.user));
            }
            onLogin(data.user);
            setIsAuthenticating(false);
            // Reload to ensure DataProvider picks up the new token
            window.location.reload();
            return;
          } else if (response.status === 401) {
            throw new Error('Invalid credentials');
          } else if (response.status >= 500 || !response.ok) {
            console.error('Server error during auth:', data.error || raw || response.statusText);
            showToast('Server/Database error. Attempting offline access...', 'warning');
          }
        } catch (serverErr: any) {
          if (serverErr?.name === 'AbortError') {
            showToast('Server auth timed out. Attempting offline access...', 'warning');
          } else if (serverErr?.message === 'Invalid credentials') {
            throw serverErr;
          } else {
            console.error('Server auth failed:', serverErr);
            showToast('Server unavailable. Attempting offline access...', 'warning');
          }
        }
      }

      // 2. Offline Fallback (Check local context cache)
      // This allows login even if the API endpoint is currently unreachable but data is loaded
      const user = team.find(u => {
        const matchesEmail = u.email?.toLowerCase() === identifier;
        const matchesCode = u.code.toLowerCase() === identifier;
        const matchesPassword = u.password === pass;
        return (matchesEmail || matchesCode) && matchesPassword;
      });

      if (user) {
        onLogin(user);
      } else {
        throw new Error('Invalid credentials. Please verify your ID/Email and Password.');
      }

    } catch (err: any) {
      setError(err.message || 'Authentication failed');
    } finally {
      setIsAuthenticating(false);
    }
  };

  const handleSendOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsAuthenticating(true);
    try {
      const res = await fetch('/api/auth/send-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: email.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to send OTP');
      showToast('OTP sent to your registered email address.', 'success');
      setView('OTP');
    } catch (err: any) {
      setError(err.message || 'Failed to send OTP');
    } finally {
      setIsAuthenticating(false);
    }
  };

  const handleVerifyOtp = (e: React.FormEvent) => {
    e.preventDefault();
    // OTP verification now happens server-side in handleResetPassword
    setView('RESET');
  };

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    if (newPassword.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    setIsAuthenticating(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/verify-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: email.trim(), otp: otp.trim(), newPassword }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to reset password');
      showToast('Password updated. Please log in.', 'success');
      setView('LOGIN');
      setPassword('');
      setOtp('');
      setError(null);
    } catch (err: any) {
      setError(err.message || 'Failed to reset password');
    } finally {
      setIsAuthenticating(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-900 flex items-center justify-center p-4 transition-colors">
      <div className="w-full max-w-md">
        <div className="flex flex-col items-center justify-center mb-8">
          <Logo variant="hero" />
          <p className="mt-3 text-xs font-bold uppercase tracking-[0.3em] text-slate-400 dark:text-slate-500">
            Xperience the Power of LifeX
          </p>
        </div>

        <div className="bg-white dark:bg-slate-800 rounded-3xl shadow-2xl shadow-slate-200 dark:shadow-slate-900 overflow-hidden border border-slate-100 dark:border-slate-700">
          <div className="p-8">
            {view === 'LOGIN' && (
              <form onSubmit={handleLoginSubmit} className="space-y-6">
                <div className="text-center mb-8">
                  <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-100">Sign In</h1>
                  <p className="text-slate-500 dark:text-slate-400 text-sm mt-1">Authorized Access Only</p>
                </div>

                {error && (
                  <div className="bg-red-50 border border-red-100 text-red-600 p-3 rounded-xl text-xs font-bold flex items-center animate-in fade-in slide-in-from-top-1">
                    <AlertCircle className="w-4 h-4 mr-2" /> {error}
                  </div>
                )}

                <div className="space-y-4">
                  <div>
                    <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest block mb-1.5">Employee ID or Email</label>
                    <div className="relative">
                      <Mail className="absolute left-4 top-3.5 w-4 h-4 text-slate-400" />
                      <input
                        type="text"
                        required
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        className="w-full pl-12 pr-4 py-3 bg-slate-50 dark:bg-slate-700 dark:text-slate-100 dark:border-slate-600 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition font-medium"
                        placeholder="ID or registered email"
                      />
                    </div>
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block">Password</label>
                      <button
                        type="button"
                        onClick={() => setView('FORGOT')}
                        className="text-[10px] font-bold text-blue-600 hover:text-blue-700 uppercase tracking-wider"
                      >
                        Recovery?
                      </button>
                    </div>
                    <div className="relative">
                      <Lock className="absolute left-4 top-3.5 w-4 h-4 text-slate-400" />
                      <input
                        type={showPassword ? "text" : "password"}
                        required
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        className="w-full pl-12 pr-12 py-3 bg-slate-50 dark:bg-slate-700 dark:text-slate-100 dark:border-slate-600 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition font-medium"
                        placeholder="••••••••"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword(!showPassword)}
                        className="absolute right-4 top-3.5 text-slate-400 hover:text-slate-600"
                      >
                        {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>
                </div>

                <button
                  id="login-btn"
                  type="submit"
                  disabled={isAuthenticating}
                  className="w-full bg-brand-teal text-white font-bold py-3.5 rounded-xl shadow-lg shadow-slate-200 hover:bg-brand-teal-dark transition flex items-center justify-center space-x-2 disabled:opacity-50"
                >
                  {isAuthenticating ? (
                    <RefreshCw className="w-5 h-5 animate-spin" />
                  ) : (
                    <>
                      <span>Secure Access</span>
                      <ArrowRight className="w-4 h-4" />
                    </>
                  )}
                </button>
              </form>
            )}

            {view === 'FORGOT' && (
              <form onSubmit={handleSendOtp} className="space-y-6">
                <div className="text-center mb-8">
                  <div className="w-16 h-16 bg-blue-50 rounded-full flex items-center justify-center mx-auto mb-4">
                    <Key className="w-8 h-8 text-blue-600" />
                  </div>
                  <h1 className="text-2xl font-bold text-slate-900">Reset Access</h1>
                  <p className="text-slate-500 text-sm mt-1">Enter registered email for recovery</p>
                </div>

                {error && (
                  <div className="bg-red-50 border border-red-100 text-red-600 p-3 rounded-xl text-xs font-bold flex items-center">
                    <AlertCircle className="w-4 h-4 mr-2" /> {error}
                  </div>
                )}

                <div>
                  <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest block mb-1.5">Registered Email</label>
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-700 dark:text-slate-100 dark:border-slate-600 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 outline-none transition font-medium"
                  />
                </div>

                <div className="flex flex-col space-y-3">
                  <button type="submit" className="w-full bg-brand-teal text-white font-bold py-3.5 rounded-xl shadow-lg shadow-slate-200 hover:bg-brand-teal-dark transition">Request Code</button>
                  <button type="button" onClick={() => setView('LOGIN')} className="w-full text-slate-500 font-bold py-2 text-sm hover:text-slate-900 transition">Back to Sign In</button>
                </div>
              </form>
            )}

            {view === 'OTP' && (
              <form onSubmit={handleVerifyOtp} className="space-y-6">
                <div className="text-center mb-8">
                  <div className="w-16 h-16 bg-blue-50 rounded-full flex items-center justify-center mx-auto mb-4">
                    <ShieldCheck className="w-8 h-8 text-blue-600" />
                  </div>
                  <h1 className="text-2xl font-bold text-slate-900">Verify Code</h1>
                  <p className="text-slate-500 text-sm mt-1">Check your registered email</p>
                </div>

                {error && (
                  <div className="bg-red-50 border border-red-100 text-red-600 p-3 rounded-xl text-xs font-bold flex items-center">
                    <AlertCircle className="w-4 h-4 mr-2" /> {error}
                  </div>
                )}

                <div className="flex justify-center">
                  <input
                    type="text"
                    required
                    maxLength={6}
                    value={otp}
                    onChange={(e) => setOtp(e.target.value)}
                    className="w-48 text-center tracking-[0.5em] text-2xl font-black py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 outline-none transition"
                    placeholder="000000"
                  />
                </div>

                <div className="flex flex-col space-y-3 text-center">
                  <button type="submit" className="w-full bg-brand-teal text-white font-bold py-3.5 rounded-xl shadow-lg shadow-slate-200 hover:bg-brand-teal-dark transition">Verify Code</button>
                  <p className="text-xs text-slate-400">Didn't receive it? <button type="button" onClick={handleSendOtp} className="text-blue-600 font-bold">Resend</button></p>
                </div>
              </form>
            )}

            {view === 'RESET' && (
              <form onSubmit={handleResetPassword} className="space-y-6">
                <div className="text-center mb-8">
                  <div className="w-16 h-16 bg-green-50 rounded-full flex items-center justify-center mx-auto mb-4">
                    <CheckCircle className="w-8 h-8 text-green-600" />
                  </div>
                  <h1 className="text-2xl font-bold text-slate-900">Set Password</h1>
                  <p className="text-slate-500 text-sm mt-1">Secure your account</p>
                </div>

                {error && (
                  <div className="bg-red-50 border border-red-100 text-red-600 p-3 rounded-xl text-xs font-bold flex items-center">
                    <AlertCircle className="w-4 h-4 mr-2" /> {error}
                  </div>
                )}

                <div className="space-y-4">
                  <div>
                    <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest block mb-1.5">New Password</label>
                    <input
                      type="password"
                      required
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-700 dark:text-slate-100 dark:border-slate-600 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 outline-none transition font-medium"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest block mb-1.5">Confirm Password</label>
                    <input
                      type="password"
                      required
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-700 dark:text-slate-100 dark:border-slate-600 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 outline-none transition font-medium"
                    />
                  </div>
                </div>

                <button type="submit" className="w-full bg-brand-teal text-white font-bold py-3.5 rounded-xl shadow-lg shadow-slate-200 hover:bg-brand-teal-dark transition">Update & Finish</button>
              </form>
            )}
          </div>

          <div className="bg-slate-50 dark:bg-slate-900/50 p-4 border-t border-slate-100 dark:border-slate-700 text-center flex flex-col items-center">
            <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest flex items-center justify-center mb-1">
              <ShieldCheck className="w-3 h-3 mr-1.5" /> Secure Enterprise System
            </p>
            <p className="text-[9px] text-slate-300 font-bold uppercase tracking-tight">
              {loading ? 'Initializing...' : isOnline ? 'System Live' : 'Maintenance Mode'}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
