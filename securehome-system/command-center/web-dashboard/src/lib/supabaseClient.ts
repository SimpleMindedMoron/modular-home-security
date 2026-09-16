import { createClient, SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

export const isSupabaseConfigured = (): boolean => {
  return (
    Boolean(supabaseUrl) &&
    Boolean(supabaseAnonKey) &&
    !supabaseUrl.includes('your-project.supabase.co') &&
    !supabaseAnonKey.includes('your-anon-key')
  );
};

// Create client with fallback dummy URL if unconfigured so Next.js doesn't crash during build
export const supabase: SupabaseClient = createClient(
  isSupabaseConfigured() ? supabaseUrl : 'https://placeholder-auth.supabase.co',
  isSupabaseConfigured() ? supabaseAnonKey : 'placeholder-anon-key'
);

export interface DeviceRecord {
  id: string;
  user_id?: string;
  name: string;
  device_type: 'camera' | 'door_lock';
  device_uid: string;
  stream_url?: string;
  status: 'online' | 'offline' | 'warning';
  last_seen?: string;
  created_at?: string;
}

export interface ProfileRecord {
  id: string;
  email: string;
  full_name?: string;
  claim_token: string;
}

// Local storage fallback for local demo mode
const LOCAL_DEVICES_KEY = 'securehome_demo_devices';

export const getDemoDevices = (): DeviceRecord[] => {
  if (typeof window === 'undefined') return [];
  try {
    const saved = localStorage.getItem(LOCAL_DEVICES_KEY);
    if (saved) {
      return JSON.parse(saved);
    }
  } catch (e) {
    console.error('Failed to parse local demo devices:', e);
  }
  // Default starter devices
  const defaultDevices: DeviceRecord[] = [
    {
      id: 'default-cam-1',
      name: 'Main Entrance Camera',
      device_type: 'camera',
      device_uid: 'ESP32_CAM_01',
      stream_url: 'http://192.168.1.145:81/stream',
      status: 'online',
    },
    {
      id: 'default-lock-1',
      name: 'Front Entry Door',
      device_type: 'door_lock',
      device_uid: 'ESP32_ACCESS_01',
      status: 'online',
    },
  ];
  return defaultDevices;
};

export const saveDemoDevices = (devices: DeviceRecord[]) => {
  if (typeof window === 'undefined') return;
  localStorage.setItem(LOCAL_DEVICES_KEY, JSON.stringify(devices));
};

export const fetchUserDevices = async (userId?: string): Promise<DeviceRecord[]> => {
  if (!isSupabaseConfigured() || !userId) {
    return getDemoDevices();
  }

  const { data, error } = await supabase
    .from('devices')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: true });

  if (error) {
    console.error('[Supabase] Failed to fetch devices:', error.message);
    return getDemoDevices();
  }

  return (data as DeviceRecord[]) || [];
};

export const createUserDevice = async (
  device: Omit<DeviceRecord, 'id' | 'created_at'>,
  userId?: string
): Promise<DeviceRecord> => {
  if (!isSupabaseConfigured() || !userId) {
    const local = getDemoDevices();
    const newDev: DeviceRecord = {
      ...device,
      id: `demo-${Date.now()}`,
      created_at: new Date().toISOString(),
    };
    local.push(newDev);
    saveDemoDevices(local);
    return newDev;
  }

  const { data, error } = await supabase
    .from('devices')
    .insert([
      {
        ...device,
        user_id: userId,
      },
    ])
    .select()
    .single();

  if (error) {
    throw new Error(error.message);
  }

  return data as DeviceRecord;
};

export const deleteUserDevice = async (deviceId: string, userId?: string): Promise<void> => {
  if (!isSupabaseConfigured() || !userId) {
    const local = getDemoDevices().filter((d) => d.id !== deviceId);
    saveDemoDevices(local);
    return;
  }

  const { error } = await supabase.from('devices').delete().eq('id', deviceId);
  if (error) {
    throw new Error(error.message);
  }
};
