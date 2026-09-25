-- ==============================================================================
-- Clean Reset & Recreate: SecureHome Cloud Supabase Schema
-- ==============================================================================

-- 1. DROP EXISTING TABLES & TRIGGERS (CASCADE handles all policies & foreign keys)
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
DROP FUNCTION IF EXISTS public.handle_new_user();

DROP TABLE IF EXISTS public.alerts CASCADE;
DROP TABLE IF EXISTS public.access_logs CASCADE;
DROP TABLE IF EXISTS public.devices CASCADE;
DROP TABLE IF EXISTS public.profiles CASCADE;

-- 2. CREATE PROFILES TABLE (Linked to Supabase Auth)
CREATE TABLE public.profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    full_name TEXT,
    claim_token UUID DEFAULT gen_random_uuid() NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own profile"
    ON public.profiles FOR SELECT
    USING (auth.uid() = id);

CREATE POLICY "Users can update own profile"
    ON public.profiles FOR UPDATE
    USING (auth.uid() = id);

-- Auto-create profile trigger on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO public.profiles (id, email, full_name)
    VALUES (NEW.id, NEW.email, NEW.raw_user_meta_data->>'full_name')
    ON CONFLICT (id) DO NOTHING;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- 3. CREATE DEVICES TABLE (Cameras & Door Locks)
CREATE TABLE public.devices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    device_type TEXT NOT NULL CHECK (device_type IN ('camera', 'door_lock')),
    device_uid TEXT NOT NULL,
    stream_url TEXT,
    status TEXT DEFAULT 'offline' CHECK (status IN ('online', 'offline', 'warning')),
    last_seen TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    UNIQUE(user_id, device_uid)
);

ALTER TABLE public.devices ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own devices"
    ON public.devices FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own devices"
    ON public.devices FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own devices"
    ON public.devices FOR UPDATE
    USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own devices"
    ON public.devices FOR DELETE
    USING (auth.uid() = user_id);

-- 4. CREATE ACCESS LOGS TABLE (RFID Events)
CREATE TABLE public.access_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    device_id UUID REFERENCES public.devices(id) ON DELETE SET NULL,
    rfid_tag TEXT NOT NULL,
    user_name TEXT DEFAULT 'Keycard User',
    granted BOOLEAN DEFAULT true NOT NULL,
    timestamp TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

ALTER TABLE public.access_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own access logs"
    ON public.access_logs FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own access logs"
    ON public.access_logs FOR INSERT
    WITH CHECK (auth.uid() = user_id);

-- 5. CREATE ALERTS TABLE (Security & AI Person Detections)
CREATE TABLE public.alerts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    device_id UUID REFERENCES public.devices(id) ON DELETE SET NULL,
    alert_type TEXT DEFAULT 'person_detected' NOT NULL,
    confidence FLOAT DEFAULT 0.0,
    snapshot_url TEXT,
    timestamp TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

ALTER TABLE public.alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own alerts"
    ON public.alerts FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own alerts"
    ON public.alerts FOR INSERT
    WITH CHECK (auth.uid() = user_id);

-- 6. CREATE REGISTERED_CARDS TABLE (NFC / RFID Card Registry per Device)
-- Mirror of the ESP32's NVS card registry, kept in sync via the dashboard.
-- Primary source of truth is the ESP32 NVS; this is a cloud backup / display layer.
CREATE TABLE public.registered_cards (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    device_uid TEXT NOT NULL,          -- Matches the ESP32's device_uid field
    uid TEXT NOT NULL,                 -- RFID UID string e.g. "AA:BB:CC:DD"
    label TEXT NOT NULL DEFAULT 'Unnamed Card',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    UNIQUE(user_id, device_uid, uid)   -- One entry per card per device per user
);

ALTER TABLE public.registered_cards ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own registered cards"
    ON public.registered_cards FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own registered cards"
    ON public.registered_cards FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own registered cards"
    ON public.registered_cards FOR UPDATE
    USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own registered cards"
    ON public.registered_cards FOR DELETE
    USING (auth.uid() = user_id);

