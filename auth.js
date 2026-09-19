/* ==========================================================================
   ezyt — авторизация через Supabase (реальная база данных).
   Снаружи по-прежнему только ник + пароль, без почты — под капотом ник
   превращается в служебный email вида "ник@ezyt.local" для Supabase Auth.
   ========================================================================== */

window.Auth = (function () {
  'use strict';

  const EMAIL_DOMAIN = '@ezyt.local';
  let cachedUser = null; // { id, username }

  function emailFor(username) { return username.trim().toLowerCase() + EMAIL_DOMAIN; }

  function validateUsername(username) {
    if (!username || username.trim().length < 2) return 'Ник — минимум 2 символа';
    return null;
  }
  function validatePassword(password) {
    if (!password || password.length < 6) return 'Пароль — минимум 6 символов';
    return null;
  }

  async function fetchUsername(id) {
    const { data, error } = await sb.from('profiles').select('username').eq('id', id).single();
    if (error || !data) return null;
    return data.username;
  }

  // остальной код (index.html/app.js) может дождаться Auth.ready перед
  // тем, как читать Auth.currentUser() — восстановление сессии асинхронно
  let readyResolve;
  const ready = new Promise((resolve) => { readyResolve = resolve; });

  async function restoreSession() {
    try {
      const { data } = await sb.auth.getSession();
      const session = data && data.session;
      if (session && session.user) {
        const username = await fetchUsername(session.user.id);
        if (username) cachedUser = { id: session.user.id, username };
      }
    } catch (e) {}
    readyResolve();
  }
  restoreSession();

  function isLoggedIn() { return !!cachedUser; }
  function currentUser() { return cachedUser; }

  async function usernameTaken(username, excludeId) {
    const { data, error } = await sb.from('profiles').select('id').ilike('username', username);
    if (error || !data) return false;
    return data.some((row) => row.id !== excludeId);
  }

  async function register(username, password) {
    username = (username || '').trim();
    const uErr = validateUsername(username);
    if (uErr) return { ok: false, message: uErr };
    const pErr = validatePassword(password);
    if (pErr) return { ok: false, message: pErr };

    if (await usernameTaken(username)) return { ok: false, message: 'Такой ник уже занят' };

    const { data, error } = await sb.auth.signUp({ email: emailFor(username), password });
    if (error) return { ok: false, message: 'Не удалось создать аккаунт: ' + error.message };
    if (!data.user) return { ok: false, message: 'Не удалось создать аккаунт' };

    const { error: profileError } = await sb.from('profiles').insert({ id: data.user.id, username });
    if (profileError) return { ok: false, message: 'Не удалось сохранить ник: ' + profileError.message };

    cachedUser = { id: data.user.id, username };
    return { ok: true };
  }

  async function login(username, password) {
    username = (username || '').trim();
    if (!username || !password) return { ok: false, message: 'Заполни оба поля' };
    const { data, error } = await sb.auth.signInWithPassword({ email: emailFor(username), password });
    if (error || !data.user) return { ok: false, message: 'Неверный ник или пароль' };
    const realUsername = await fetchUsername(data.user.id);
    cachedUser = { id: data.user.id, username: realUsername || username };
    return { ok: true };
  }

  async function logout() {
    try { await sb.auth.signOut(); } catch (e) {}
    cachedUser = null;
  }

  async function requireLogin() {
    await ready;
    if (!isLoggedIn()) window.location.replace('login.html');
  }

  async function changeUsername(newUsername) {
    newUsername = (newUsername || '').trim();
    const uErr = validateUsername(newUsername);
    if (uErr) return { ok: false, message: uErr };
    if (!cachedUser) return { ok: false, message: 'Не авторизован' };
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
    const { error: reauthError } = await sb.auth.signInWithPassword({ email: emailFor(cachedUser.username), password: currentPassword });
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
