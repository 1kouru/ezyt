/* ==========================================================================
   ezyt — авторизация через Supabase (реальная база данных).
   Регистрация — ник + настоящий email + пароль (email идёт напрямую в
   Supabase Auth, без подмен). Вход — по нику ИЛИ по email (одно поле,
   определяется автоматически по наличию "@") + пароль.
   ========================================================================== */

window.Auth = (function () {
  'use strict';

  let cachedUser = null; // { id, username, email }

  function validateUsername(username) {
    if (!username || username.trim().length < 2) return 'Ник — минимум 2 символа';
    return null;
  }
  function validateEmail(email) {
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return 'Введи корректный email';
    return null;
  }
  function validatePassword(password) {
    if (!password || password.length < 6) return 'Пароль — минимум 6 символов';
    return null;
  }

  async function fetchProfile(id) {
    const { data, error } = await sb.from('profiles').select('username, email').eq('id', id).single();
    if (error) { console.error('ezyt: fetchProfile failed', error); return null; }
    return data;
  }

  // остальной код (index.html/app.js) может дождаться Auth.ready перед
  // тем, как читать Auth.currentUser() — восстановление сессии асинхронно
  let readyResolve;
  const ready = new Promise((resolve) => { readyResolve = resolve; });

  async function restoreSession() {
    try {
      const { data, error } = await sb.auth.getSession();
      if (error) console.error('ezyt: getSession failed', error);
      const session = data && data.session;
      if (session && session.user) {
        const profile = await fetchProfile(session.user.id);
        if (profile) cachedUser = { id: session.user.id, username: profile.username, email: profile.email };
      }
    } catch (e) { console.error('ezyt: restoreSession failed', e); }
    readyResolve();
  }
  restoreSession();

  function isLoggedIn() { return !!cachedUser; }
  function currentUser() { return cachedUser; }

  async function usernameTaken(username, excludeId) {
    const { data, error } = await sb.rpc('is_username_taken', { check_username: username, exclude_id: excludeId || null });
    if (error) { console.error('ezyt: is_username_taken failed', error); return false; }
    return !!data;
  }
  async function emailForUsername(username) {
    const { data, error } = await sb.rpc('email_for_username', { p_username: username });
    if (error) { console.error('ezyt: email_for_username failed', error); return null; }
    return data || null;
  }

  async function register(username, email, password) {
    username = (username || '').trim();
    email = (email || '').trim();
    const uErr = validateUsername(username);
    if (uErr) return { ok: false, message: uErr };
    const eErr = validateEmail(email);
    if (eErr) return { ok: false, message: eErr };
    const pErr = validatePassword(password);
    if (pErr) return { ok: false, message: pErr };

    if (await usernameTaken(username)) return { ok: false, message: 'Такой ник уже занят' };

    const { data, error } = await sb.auth.signUp({ email, password });
    if (error) {
      const msg = /registered/i.test(error.message) ? 'Этот email уже зарегистрирован' : 'Не удалось создать аккаунт: ' + error.message;
      return { ok: false, message: msg };
    }
    if (!data.user) return { ok: false, message: 'Не удалось создать аккаунт' };

    const { error: profileError } = await sb.from('profiles').insert({ id: data.user.id, username, email });
    if (profileError) {
      await sb.auth.signOut();
      const msg = profileError.code === '23505' ? 'Такой ник или email уже используется' : 'Не удалось сохранить профиль: ' + profileError.message;
      return { ok: false, message: msg };
    }

    cachedUser = { id: data.user.id, username, email };
    return { ok: true };
  }

  // identifier — ник или email, определяем автоматически по наличию "@"
  async function login(identifier, password) {
    identifier = (identifier || '').trim();
    if (!identifier || !password) return { ok: false, message: 'Заполни оба поля' };

    let email = identifier;
    if (!identifier.includes('@')) {
      const resolved = await emailForUsername(identifier);
      if (!resolved) return { ok: false, message: 'Неверный ник/email или пароль' };
      email = resolved;
    }

    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error || !data.user) return { ok: false, message: 'Неверный ник/email или пароль' };
    const profile = await fetchProfile(data.user.id);
    cachedUser = { id: data.user.id, username: (profile && profile.username) || identifier, email: (profile && profile.email) || email };
    return { ok: true };
  }

  async function logout() {
    try { await sb.auth.signOut(); } catch (e) {}
    cachedUser = null;
  }

  async function requireLogin() {
    await ready;
    if (!isLoggedIn()) window.location.replace('/login/');
  }

  async function changeUsername(newUsername) {
    newUsername = (newUsername || '').trim();
    const uErr = validateUsername(newUsername);
    if (uErr) return { ok: false, message: uErr };
    if (!cachedUser) return { ok: false, message: 'Не авторизован' };
    if (newUsername.toLowerCase() === cachedUser.username.toLowerCase()) return { ok: true };
    if (await usernameTaken(newUsername, cachedUser.id)) return { ok: false, message: 'Такой ник уже занят' };
    const { error } = await sb.from('profiles').update({ username: newUsername }).eq('id', cachedUser.id);
    if (error) return { ok: false, message: 'Не удалось обновить ник' };
    cachedUser.username = newUsername;
    return { ok: true };
  }

  async function changePassword(currentPassword, newPassword) {
    if (!cachedUser) return { ok: false, message: 'Не авторизован' };
    const pErr = validatePassword(newPassword);
    if (pErr) return { ok: false, message: pErr };
    const { error: reauthError } = await sb.auth.signInWithPassword({ email: cachedUser.email, password: currentPassword });
    if (reauthError) return { ok: false, message: 'Неверный текущий пароль' };
    const { error } = await sb.auth.updateUser({ password: newPassword });
    if (error) return { ok: false, message: 'Не удалось изменить пароль' };
    return { ok: true };
  }

  async function deleteAccount() {
    // полное удаление пользователя из Supabase Auth требует service_role
    // ключа — его нельзя держать в браузере, поэтому кнопка выхода есть,
    // а самостоятельное удаление аккаунта отсюда недоступно.
    return { ok: false, message: 'Удаление аккаунта пока недоступно' };
  }

  return {
    ready, register, login, logout, isLoggedIn, currentUser, requireLogin,
    changeUsername, changePassword, deleteAccount,
  };
})();
