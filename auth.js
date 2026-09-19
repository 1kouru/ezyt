/* ==========================================================================
   ezyt — простая локальная авторизация (без бэкенда, без почты).
   Только ник + пароль. Пароли хранятся как есть в localStorage браузера —
   это НЕ настоящая защита, только заглушка интерфейса до появления
   реальной базы данных.
   ========================================================================== */

window.Auth = (function () {
  'use strict';

  const USERS_KEY = 'ezytUsers';
  const SESSION_KEY = 'ezytSession';

  function loadUsers() {
    try { return JSON.parse(localStorage.getItem(USERS_KEY)) || []; }
    catch (e) { return []; }
  }
  function saveUsers(users) {
    try { localStorage.setItem(USERS_KEY, JSON.stringify(users)); } catch (e) {}
  }
  function findUser(users, username) {
    return users.find((u) => u.username.toLowerCase() === String(username || '').toLowerCase());
  }

  function isLoggedIn() {
    try { return !!JSON.parse(localStorage.getItem(SESSION_KEY)); }
    catch (e) { return false; }
  }
  function currentUser() {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY)); }
    catch (e) { return null; }
  }
  function setSession(username) {
    try { localStorage.setItem(SESSION_KEY, JSON.stringify({ username })); } catch (e) {}
  }
  function logout() {
    try { localStorage.removeItem(SESSION_KEY); } catch (e) {}
  }

  function validateUsername(username) {
    if (!username || username.trim().length < 2) return 'Ник — минимум 2 символа';
    return null;
  }
  function validatePassword(password) {
    if (!password || password.length < 6) return 'Пароль — минимум 6 символов';
    return null;
  }

  function register(username, password) {
    username = (username || '').trim();
    const uErr = validateUsername(username);
    if (uErr) return { ok: false, message: uErr };
    const pErr = validatePassword(password);
    if (pErr) return { ok: false, message: pErr };
    const users = loadUsers();
    if (findUser(users, username)) return { ok: false, message: 'Такой ник уже занят' };
    users.push({ username, password });
    saveUsers(users);
    setSession(username);
    return { ok: true };
  }

  function login(username, password) {
    username = (username || '').trim();
    if (!username || !password) return { ok: false, message: 'Заполни оба поля' };
    const users = loadUsers();
    const user = findUser(users, username);
    if (!user || user.password !== password) return { ok: false, message: 'Неверный ник или пароль' };
    setSession(user.username);
    return { ok: true };
  }

  function changeUsername(newUsername) {
    newUsername = (newUsername || '').trim();
    const uErr = validateUsername(newUsername);
    if (uErr) return { ok: false, message: uErr };
    const current = currentUser();
    if (!current) return { ok: false, message: 'Не авторизован' };
    const users = loadUsers();
    const taken = users.some((u) => u.username.toLowerCase() === newUsername.toLowerCase() && u.username.toLowerCase() !== current.username.toLowerCase());
    if (taken) return { ok: false, message: 'Такой ник уже занят' };
    const user = findUser(users, current.username);
    if (!user) return { ok: false, message: 'Пользователь не найден' };
    user.username = newUsername;
    saveUsers(users);
    setSession(newUsername);
    return { ok: true };
  }

  function changePassword(currentPassword, newPassword) {
    const current = currentUser();
    if (!current) return { ok: false, message: 'Не авторизован' };
    const pErr = validatePassword(newPassword);
    if (pErr) return { ok: false, message: pErr };
    const users = loadUsers();
    const user = findUser(users, current.username);
    if (!user || user.password !== currentPassword) return { ok: false, message: 'Неверный текущий пароль' };
    user.password = newPassword;
    saveUsers(users);
    return { ok: true };
  }

  function deleteAccount(password) {
    const current = currentUser();
    if (!current) return { ok: false, message: 'Не авторизован' };
    const users = loadUsers();
    const user = findUser(users, current.username);
    if (!user || user.password !== password) return { ok: false, message: 'Неверный пароль' };
    saveUsers(users.filter((u) => u !== user));
    logout();
    return { ok: true };
  }

  function requireLogin() {
    if (!isLoggedIn()) window.location.replace('login.html');
  }

  return {
    register, login, logout, isLoggedIn, currentUser, requireLogin,
    changeUsername, changePassword, deleteAccount,
  };
})();
