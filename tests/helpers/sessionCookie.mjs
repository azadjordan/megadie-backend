import generateToken from "../../utils/generateToken.js";

// Tests call this only after explicitly connecting to a disposable database.
export function testSessionCookies() {
  const cookies = new Map();
  return async (user) => {
    const id = String(user._id);
    if (!cookies.has(id)) {
      let cookie;
      await generateToken({ cookie: (name, value) => { cookie = `${name}=${value}`; } }, user);
      cookies.set(id, cookie);
    }
    return cookies.get(id);
  };
}
