# Gluten Free Map

Mapa colaborativo para lugares y productos aptos, con:

- fotos multiples por lugar
- puntuacion de 1 a 5
- comentarios por usuario
- moderacion de lugares
- persistencia en PostgreSQL

## Requisitos

- Node 22.14.0 o compatible
- Docker y Docker Compose si queres levantar todo containerizado

## Levantar con Docker

El camino recomendado.

```bash
cp .env.example .env
docker compose up --build
```

La app queda en `http://localhost:3001`.

Servicios:

- `app`: frontend compilado + API Express
- `db`: PostgreSQL 16

## Deploy gratis con dominio `onrender.com`

Deje el repo preparado para Render con [render.yaml](./render.yaml). Esa opcion
te da:

- app publica con subdominio gratis `*.onrender.com`
- HTTPS administrado por Render
- PostgreSQL gratis enlazado por `DATABASE_URL`

Pasos:

1. Subi este repo a GitHub.
2. Crea una cuenta en Render.
3. En Render, elegi `New > Blueprint`.
4. Conecta el repo y confirma el `render.yaml`.
5. Render va a crear:
   - un web service `gluten-free-map`
   - una base `gluten-free-map-db`
6. Cuando termine, la app queda publicada en una URL `https://<nombre>.onrender.com`.

Limitaciones reales del plan gratis de Render:

- el web service se duerme tras 15 minutos sin trafico
- la primera carga despues de dormirse tarda mas
- la base Postgres gratis vence a los 30 dias si no la pasas a un plan pago
- solo admite una base Postgres gratis por workspace

Si mas adelante compras un dominio propio, Render tambien permite conectarlo sin
rehacer el deploy.

## Desarrollo local

Si preferis correr sin Docker, primero necesitás un PostgreSQL accesible y definir
`DATABASE_URL`.

Ejemplo:

```bash
export DATABASE_URL=postgresql://gluten_free_map:gluten_free_map@localhost:5432/gluten_free_map
nvm use
npm install
npm run dev
```

El frontend usa Vite y el backend Express corre en paralelo.

## Scripts

- `npm run dev`: frontend + backend en modo desarrollo
- `npm run build`: build del frontend
- `npm run start`: backend sirviendo la build
- `npm run preview`: alias de `start`
- `npm run lint`: lint del frontend

## Persistencia

- Lugares, fotos, reseñas y aprobaciones quedan en PostgreSQL
- Las fotos se guardan en la base como `BYTEA`
- Si la base arranca vacía, el backend carga datos demo

## Notas

- El login sigue siendo demo/local en el frontend
- Para que la app arranque, el backend necesita `DATABASE_URL`
# gluten-free-map
