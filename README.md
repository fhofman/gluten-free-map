# Gluten Free Map

Mapa comunitario para celíacos con frontend y backend separados.

## Qué cambió

- frontend React/Vite en [`frontend/`](./frontend)
- backend Express/PostgreSQL en [`backend/`](./backend)
- auth real con WorkOS
- uploads con UploadThing
- mapa full-screen con paneles flotantes
- catálogo de sitios web sin dirección física
- panel admin separado para moderación y verificación
- script para promover admins por email

## Stack

- frontend: React 19, Vite, React Router, Pigeon Maps, UploadThing
- backend: Node 22, Express 5, PostgreSQL, WorkOS, UploadThing
- seguridad: sesiones por cookie, CSRF, CORS restringido, rate limiting, `helmet`

## Variables de entorno

Partí de [`.env.example`](./.env.example).

Variables clave:

- `DATABASE_URL`
- `FRONTEND_URL`
- `BACKEND_URL`
- `ALLOWED_ORIGINS`
- `WORKOS_API_KEY`
- `WORKOS_CLIENT_ID`
- `WORKOS_COOKIE_PASSWORD`
- `UPLOADTHING_TOKEN`
- `UPLOADTHING_CALLBACK_URL`
- `VITE_API_BASE_URL`

Notas:

- si no configurás WorkOS, la app arranca igual pero el login queda deshabilitado
- si no configurás UploadThing, la carga de fotos queda deshabilitada
- si frontend y backend corren en dominios distintos, definí `UPLOADTHING_CALLBACK_URL` con el URL público del backend (`https://.../api/uploadthing`)

## Desarrollo local

1. Copiá el archivo de ejemplo:

```bash
cp .env.example .env
```

2. Si corrés Postgres fuera de Docker, definí `DATABASE_URL`.

3. Instalá dependencias y levantá ambos servicios:

```bash
nvm use
npm install
npm run dev
```

Puertos por defecto:

- frontend: `http://localhost:5173`
- backend: `http://localhost:3001`

## Docker Compose

Levanta `frontend`, `backend` y `db` por separado:

```bash
docker compose up --build
```

Puertos por defecto:

- frontend: `http://localhost:4173`
- backend: `http://localhost:3001`

## Scripts

- `npm run dev`: frontend + backend en paralelo
- `npm run dev:web`: Vite para el frontend
- `npm run dev:api`: API Express con watch
- `npm run build`: build completo
- `npm run build:web`: build del frontend
- `npm run build:api`: chequeo sintáctico del backend
- `npm run start`: backend en modo producción
- `npm run preview`: preview del frontend

## Admin

No se crea desde la UI.

Promové un email a admin con:

```bash
DATABASE_URL=postgresql://... node backend/scripts/create-admin.mjs admin@example.com "Admin Name"
```

El script deja ese email con rol `admin` en la tabla `users`. Cuando ese usuario entre por WorkOS, conservará el rol.

Si corrés el script desde tu máquina contra la URL externa de Render, agregá `?sslmode=require` al `DATABASE_URL` o definí `PGSSLMODE=require`.

## Deploy en Render

El deploy en Render queda resuelto con un solo servicio Node en [`render.yaml`](./render.yaml):

- `gluten-free-map`: backend Express sirviendo tambien el build del frontend

Además crea la base `gluten-free-map-db`.

Variables sensibles en el Blueprint:

- `WORKOS_API_KEY`
- `WORKOS_CLIENT_ID`
- `WORKOS_COOKIE_PASSWORD`
- `UPLOADTHING_TOKEN`

Checklist de dominios:

- `https://gluten-free-map.onrender.com` sirve frontend y API
- el frontend llama al API en `/api`
- el callback de WorkOS tiene que ser `https://gluten-free-map.onrender.com/api/auth/callback`

El Blueprint fija `NODE_VERSION=22.14.0`. Si el servicio fue creado antes con otra configuración, conviene revisar esa variable tambien en el Dashboard.

## Seguridad

Mejoras aplicadas:

- ya no se acepta el rol del usuario desde el frontend
- la sesión vive del lado servidor con WorkOS
- protección CSRF en endpoints mutantes
- cookies `httpOnly`
- CORS limitado por `ALLOWED_ORIGINS`
- `helmet` para headers de seguridad
- rate limiting en auth y escrituras
- `npm audit --omit=dev` limpio en dependencias de producción
