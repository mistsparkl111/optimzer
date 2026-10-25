// Usage:
//   npm run admin -- promote user@example.ru        make an existing user admin
//   npm run admin -- create user@example.ru Pass123  create an admin account
//   npm run admin -- plus user@example.ru 30         grant Radar+ for N days
import { db } from '../db';
import { hashPassword } from '../crypto';
import { extendPlus, getUserByEmail } from '../users';

const [cmd, email, arg] = process.argv.slice(2);
if (!cmd || !email) {
  console.log('Команды: promote <email> | create <email> <password> | plus <email> <days>');
  process.exit(1);
}
const u = getUserByEmail(email);
if (cmd === 'promote') {
  if (!u) throw new Error('Пользователь не найден');
  db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(u.id);
  console.log(`${email} теперь администратор`);
} else if (cmd === 'create') {
  if (u) throw new Error('Пользователь уже существует');
  if (!arg || arg.length < 8) throw new Error('Пароль минимум 8 символов');
  db.prepare("INSERT INTO users (email, name, password_hash, role, created_at) VALUES (?, 'Администратор', ?, 'admin', ?)").run(
    email.toLowerCase(),
    hashPassword(arg),
    Date.now(),
  );
  console.log(`Создан администратор ${email}`);
} else if (cmd === 'plus') {
  if (!u) throw new Error('Пользователь не найден');
  const until = extendPlus(u.id, Number(arg || 30));
  console.log(`Радар+ до ${new Date(until).toLocaleString('ru-RU')}`);
}
