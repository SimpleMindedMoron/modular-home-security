'use client';

import React, { createContext, useContext, useEffect, useState } from 'react';
import { User, Session } from '@supabase/supabase-js';
import { supabase, isSupabaseConfigured } from '../lib/supabaseClient';

interface AuthContextType {
  user: User | null;
  session: Session | null;
  isLoading: boolean;
  isDemo: boolean;
  claimToken: string;
  signIn: (email: string, pass: string) => Promise<{ error?: string }>;
  signUp: (email: string, pass: string, fullName?: string) => Promise<{ error?: string }>;
  signOut: () => Promise<void>;
  enterDemoMode: () => void;
  deleteAccount: (password: string) => Promise<{ error?: string }>;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  session: null,
  isLoading: true,
  isDemo: false,
  claimToken: '',
  signIn: async () => ({}),
  signUp: async () => ({}),
  signOut: async () => {},
  enterDemoMode: () => {},
  deleteAccount: async () => ({}),
});

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isDemo, setIsDemo] = useState<boolean>(false);
  const [claimToken, setClaimToken] = useState<string>('');

  useEffect(() => {
    // Check if demo mode was previously active
    const savedDemo = typeof window !== 'undefined' && localStorage.getItem('securehome_demo_mode') === 'true';

    if (!isSupabaseConfigured()) {
      setIsDemo(true);
      setClaimToken('demo-account-claim-token-1234');
      setIsLoading(false);
      return;
    }

    if (savedDemo) {
      setIsDemo(true);
      setClaimToken('demo-account-claim-token-1234');
      setIsLoading(false);
      return;
    }

    // Initialize Supabase session
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setUser(session?.user ?? null);
      if (session?.user) {
        loadClaimToken(session.user.id);
      }
      setIsLoading(false);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
      setUser(session?.user ?? null);
      if (session?.user) {
        setIsDemo(false);
        if (typeof window !== 'undefined') localStorage.removeItem('securehome_demo_mode');
        loadClaimToken(session.user.id);
      }
      setIsLoading(false);
    });

    return () => subscription.unsubscribe();
  }, []);

  const loadClaimToken = async (userId: string) => {
    try {
      const { data } = await supabase
        .from('profiles')
        .select('claim_token')
        .eq('id', userId)
        .single();
      if (data?.claim_token) {
        setClaimToken(data.claim_token);
      } else {
        setClaimToken(userId); // Fallback to user UUID
      }
    } catch {
      setClaimToken(userId);
    }
  };

  const signIn = async (email: string, pass: string): Promise<{ error?: string }> => {
    if (!isSupabaseConfigured()) {
      enterDemoMode();
      return {};
    }
    const { error } = await supabase.auth.signInWithPassword({ email, password: pass });
    if (error) return { error: error.message };
    return {};
  };

  const signUp = async (email: string, pass: string, fullName?: string): Promise<{ error?: string }> => {
    if (!isSupabaseConfigured()) {
      enterDemoMode();
      return {};
    }
    const { error } = await supabase.auth.signUp({
      email,
      password: pass,
      options: {
        data: { full_name: fullName || '' },
      },
    });
    if (error) return { error: error.message };
    return {};
  };

  const signOut = async () => {
    if (isSupabaseConfigured()) {
      await supabase.auth.signOut();
    }
    setUser(null);
    setSession(null);
    setIsDemo(false);
    if (typeof window !== 'undefined') {
      localStorage.removeItem('securehome_demo_mode');
    }
  };

  // ---------------------------------------------------------------------------
  // Delete Account — re-authenticates with password before deleting
  // ---------------------------------------------------------------------------
  const deleteAccount = async (password: string): Promise<{ error?: string }> => {
    if (isDemo) {
      // In demo mode: just clear local state and exit
      setUser(null);
      setSession(null);
      setIsDemo(false);
      if (typeof window !== 'undefined') {
        localStorage.removeItem('securehome_demo_mode');
      }
      return {};
    }

    if (!isSupabaseConfigured() || !user?.email) {
      return { error: 'Not authenticated or Supabase not configured.' };
    }

    // Step 1: Re-authenticate with password to confirm identity
    const { error: reAuthError } = await supabase.auth.signInWithPassword({
      email: user.email,
      password,
    });
    if (reAuthError) {
      return { error: 'Incorrect password. Account was NOT deleted.' };
    }

    // Step 2: Delete the user via Supabase Admin API (server-side Next.js route)
    try {
      const res = await fetch('/api/auth/delete-account', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.id }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        return { error: body.error || 'Failed to delete account on server.' };
      }
    } catch {
      return { error: 'Network error while deleting account.' };
    }

    // Step 3: Sign out locally
    await supabase.auth.signOut();
    setUser(null);
    setSession(null);
    if (typeof window !== 'undefined') {
      localStorage.clear();
    }
    return {};
  };

  const enterDemoMode = () => {
    setIsDemo(true);
    setUser({
      id: 'demo-user-id',
      email: 'demo@securehome.cloud',
      app_metadata: {},
      user_metadata: { full_name: 'Demo Administrator' },
      aud: 'authenticated',
      created_at: new Date().toISOString(),
    } as unknown as User);
    setClaimToken('demo-account-claim-token-1234');
    if (typeof window !== 'undefined') {
      localStorage.setItem('securehome_demo_mode', 'true');
    }
    setIsLoading(false);
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        session,
        isLoading,
        isDemo,
        claimToken,
        signIn,
        signUp,
        signOut,
        enterDemoMode,
        deleteAccount,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);
