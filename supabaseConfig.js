/* ==========================================================================
   Подключение к Supabase — реальная база данных вместо localStorage.
   Anon-ключ ниже безопасно светить в клиентском коде: доступ к данным
   всё равно ограничен политиками Row Level Security на стороне базы —
   каждый пользователь видит и меняет только свои собственные строки.
   ========================================================================== */

window.sb = supabase.createClient(
  'https://yvinujzttxuezbrnhqak.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl2aW51anp0dHh1ZXpicm5ocWFrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk3ODMxMjAsImV4cCI6MjEwNTM1OTEyMH0.8-Bt12IbwH0J1hnPsi4gA4tzkn-KqFp4zrzvfhMOgYI'
);
