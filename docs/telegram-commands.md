# Comandos de Telegram

## Acceso

La Lambda `prestamype-monitor-commands` recibe mensajes por Function URL y verifica
`X-Telegram-Bot-Api-Secret-Token`. Solo procesa mensajes normales (no editados),
ignora bots y remitentes anónimos, y comprueba usuario y chat en cada solicitud.

Los chats de `/prestamype/prod/telegram-chat-id` pueden usar `/ayuda`,
`/oportunidades`, `/detalle ID` y `/criterios`. Las consultas leen datos guardados;
no abren el navegador. La lista muestra hasta cinco resultados de los primeros
100 registros consultados; puede no ser exhaustiva. Se muestra la fecha de los
datos y no se garantiza que la oferta siga disponible en Prestamype.

Solo el usuario configurado en `TelegramOwnerId`, dentro de su propio chat privado,
puede usar `/estado`, `/escanear`, `/pausar` y `/reanudar`. Los comandos privados no
se ejecutan desde grupos, aunque quien los envíe sea el propietario. La función
no tiene permisos para leer la sesión de Prestamype ni su clave de cifrado.

No se implementan inversiones, modificaciones de filtros ni administración de
blacklist por Telegram. Los datos de saldo, exposición y blacklist no se muestran
en las consultas públicas. Los nombres de usuario no otorgan permisos.

## Ejecución y límites

- Lambda de comandos: 128 MiB, timeout de 10 segundos, sin capa de Chromium.
- Telegram entrega por webhook, con una conexión; no hay polling periódico.
- La respuesta usa el método `sendMessage` en el cuerpo HTTP del webhook.
- Una transacción de DynamoDB deduplica `update_id`, limita cada usuario a un
  comando cada tres segundos y aplica un máximo global de 2.000 comandos/mes UTC.
- `/escanear`: máximo cinco solicitudes por día UTC, separadas diez minutos.
  Invoca la Lambda existente de forma asíncrona. Respeta su estado, pausas,
  bloqueo de ejecución y control de presupuesto. La finalización se notifica
  únicamente al propietario; las alertas siguen sus destinos habituales.
- `/pausar` desactiva futuras ejecuciones; no interrumpe una que ya empezó.
- `/reanudar` activa el monitor, pero nunca elimina una pausa de seguridad o costo.
- Duplicados, solicitudes no autorizadas y límites alcanzados se descartan sin
  responder para evitar amplificación. Espera tres segundos entre comandos.
- Las claves de deduplicación duran siete días mediante TTL; las cuotas mensuales
  duran 40 días. Una respuesta perdida no se repite automáticamente. Si una
  acción tuvo resultado ambiguo, revisar `/estado` antes de solicitarla otra vez.

## Presupuesto

Cada comando aceptado añade una reserva de 1,25 GB-s (128 MiB × 10 s) a
`USAGE#AAAA-MM.commandGbSeconds`. El guard del escáner suma esa reserva a su
consumo calculado. El máximo reservado para 2.000 comandos es 2.500 GB-s/mes.

Es una estimación conservadora del tiempo de ejecución aceptado, no una factura:
no incluye arranques, solicitudes rechazadas, otros proyectos, logs o DynamoDB.
La URL pública puede recibir solicitudes no autorizadas que también generan
invocaciones, aunque el secreto impide ejecutar comandos. No garantiza costo cero.

## Despliegue

1. Autenticar AWS (`aws login --profile prestamype`).
2. Ejecutar `node scripts/setup-telegram-webhook.mjs --prepare`. Crea el secreto
   SecureString si falta y muestra únicamente el nombre público del bot.
3. Confirmar los parámetros `TelegramOwnerId` y `TelegramBotUsername`, compilar y
   desplegar con SAM.
4. Ejecutar `node scripts/setup-telegram-webhook.mjs`. Registra webhook y menús:
   comandos públicos por defecto y comandos privados en el chat del propietario.
   No sustituye un webhook de otra URL y no descarta actualizaciones pendientes.
5. Probar `/ayuda` y `/estado` en privado. Revisar CloudWatch y `getWebhookInfo`.

No usar scripts basados en `getUpdates` mientras el webhook esté registrado.
El script de registro conserva tokens y secretos en memoria; no los imprime.
