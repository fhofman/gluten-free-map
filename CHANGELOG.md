# Changelog

Todos los cambios relevantes de este proyecto se documentan en este archivo.

Este proyecto usa versionado semántico (SemVer):
- `MAJOR`: cambios incompatibles.
- `MINOR`: mejoras compatibles.
- `PATCH`: correcciones compatibles.

## [Unreleased]

### Added
- Flujo de versionado con `scripts/release.mjs` y comandos `npm run release`, `release:patch`, `release:minor`, `release:major`.
- Vista previa de ubicación en el mapa al buscar direcciones durante el alta de lugares físicos.
- Botón `Subir imagen` para desplegar el bloque de carga en formularios de alta de lugar y reseñas.

### Changed
- El bloque de carga de imágenes ahora inicia cerrado y se abre bajo demanda.
- El área de arrastrar/seleccionar imagen se compactó para ocupar menos espacio visual.
- La búsqueda de dirección ahora centra el mapa y preselecciona la primera coincidencia con latitud/longitud.
- La carga de imágenes se mantiene en modo automático: al arrastrar o elegir archivo, se sube sin pasos extra.

### Fixed
- Limpieza del estado de vista previa de coordenadas al cerrar o reabrir el formulario de alta.
- Reseteo consistente del estado de carga de imágenes al cerrar formularios o cambiar de lugar seleccionado.

### Removed

### Security

## [0.0.0] - 2026-04-02

### Added
- Base inicial del proyecto.
