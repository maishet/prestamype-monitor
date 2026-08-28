# Prestamype monitor

Monitor experimental de oportunidades de factoring, construido para Node.js 22. Solo lee la cartera y las oportunidades, evalúa reglas locales y genera recomendaciones. No reserva, oferta, invierte, transfiere dinero ni ejecuta ninguna otra acción financiera.

## Instalación y comprobaciones

Instala Node.js 22 y luego ejecuta:

```powershell
npm ci
npm test
npm run typecheck
npm run lint
npm run format:check
```

El despliegue en AWS está aplazado. Los comandos locales no crean infraestructura ni recursos de AWS.

## Sesión autenticada

La autenticación se realiza manualmente en un navegador visible. Un adaptador local, fuera del repositorio, debe exportar `createCaptureDependencies` y proporcionar el navegador, el almacén de sesión y una clave de 32 bytes. Configura su ruta mediante `PRESTAMYPE_CAPTURE_ADAPTER` y ejecuta:

```powershell
npm run auth:capture
```

La herramienta nunca solicita ni almacena la contraseña. El estado de sesión se cifra con AES-256-GCM antes de guardarse. No incluyas claves, cookies, tokens ni contenido de sesión en el repositorio, variables impresas, ejemplos, registros o reportes de errores.

## Dry-run con fixtures

```powershell
npm run dry-run -- --fixture
```

Este es el modo seguro por defecto para comprobaciones locales: usa únicamente los fixtures sanitizados conocidos de `tests/fixtures`, valida con `lstat` y `realpath` que el directorio y los archivos regulares no sean enlaces ni escapen de esa raíz, no carga adaptadores y no accede a la red. Produce un resumen estable de decisión, score, riesgo, retorno, monto e identificador sanitizado. La inyección de contenido de fixture existe solo como seam de pruebas y quien la invoque debe tratar ese contenido como confiable; el CLI no la utiliza.

## Dry-run con la cuenta real

El acceso real nunca es implícito. Requiere `--live` y un adaptador indicado por `PRESTAMYPE_DRY_RUN_ADAPTER`. Las rutas absolutas o relativas se convierten a URL `file:` desde el directorio actual; también se admiten specifiers locales `file:`, `data:`, `node:` o de paquete. Se rechazan URL de red como `http:` y `https:`, rutas UNC/protocol-relative y cualquier URL `file:` con autoridad o hostname, incluido `localhost`; una URL de archivo debe ser hostless, tener una ruta válida y no contener separadores `/` o `\` codificados, incluso tras hasta tres rondas de decodificación segura. Ese módulo debe exportar una función asíncrona `createDryRunDependencies` que entregue `store`, `key` y `launcher`; opcionalmente puede entregar `config` y `blacklist`.

```powershell
npm run dry-run -- --live
```

El modo live descifra la sesión en memoria, abre un cliente Prestamype de solo lectura, consulta cartera y oportunidades y muestra mensajes prospectivos prefijados con `[NO ENVIADO]`. No acepta un notificador ni un repositorio, no reclama o guarda alertas y no escribe datos. Siempre intenta cerrar el navegador y aborta de forma segura al vencer el plazo.

## Límites de seguridad

- La salida usa una lista permitida de campos financieros y aplica sanitización antes y después del formateo. Redacta patrones y campos sensibles conocidos: RUC de 11 dígitos, cabeceras de autorización/cookies, credenciales Basic/Bearer, JWT, tokens, contraseñas, claves API y sesiones. También elimina controles y limita líneas y tamaño. No es posible prometer la detección de cualquier secreto arbitrario sin forma reconocible; no introduzcas secretos en nombres, razones, fixtures o configuración visible.
- Los errores externos se convierten en mensajes genéricos; no se imprime la excepción original.
- El proyecto no resuelve ni evade CAPTCHA. Ante un desafío, expiración o bloqueo debe detenerse y requerir intervención manual.
- Las recomendaciones son informativas. No sustituyen la decisión del usuario y no existe código para realizar inversiones.
- Usa únicamente páginas visibles y navegación conservadora; no consume endpoints privados obtenidos por ingeniería inversa.

Para desarrollar, usa `npm run test:watch`. Los fixtures deben permanecer ficticios y sanitizados.
