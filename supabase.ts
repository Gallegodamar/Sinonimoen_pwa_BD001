
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.1';

// Usamos placeholders válidos sintácticamente para evitar el error "is required" en el arranque.
// En un entorno de producción, estas variables deben estar en process.env
const supabaseUrl = (process.env as any).SUPABASE_URL || 'https://ixomccijzghtghqmqtma.supabase.co';
const supabaseAnonKey = (process.env as any).SUPABASE_ANON_KEY || 'sb_publishable_r1WBXKqC-MUCo3ilFM9Xsg_6v78aqAG';

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
