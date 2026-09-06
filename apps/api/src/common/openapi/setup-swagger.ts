import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import type { AppConfigService } from '../../config/app-config.service.js';
import {
  API_ERROR_BODY_COMPONENT,
  API_ERROR_BODY_SCHEMA,
  contractSchemaRegistry,
} from './contract-schemas.js';

export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('Wasel Attendance API')
    .setDescription(
      'Geofenced attendance for multi-tenant organisations. Every request and ' +
        'response shape below is generated from the Zod schemas in ' +
        '`@wasel/contracts`, which are the same schemas that validate live traffic.',
    )
    .setVersion('1.0.0')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'access-token')
    // No `.addServer('/api/v1')`: Nest's scanner already emits the global prefix
    // in every path, so declaring it again as the server URL made every "Try it
    // out" and every generated client request `/api/v1/api/v1/...` — a 404.
    .build();

  const document = SwaggerModule.createDocument(app, config);
  const { components } = contractSchemaRegistry();

  document.components ??= {};
  document.components.schemas = {
    ...document.components.schemas,
    ...components,
    [API_ERROR_BODY_COMPONENT]: API_ERROR_BODY_SCHEMA,
  };

  return document;
}

/**
 * Mounts Swagger UI outside the `api/v1` prefix so the documentation URL stays
 * stable across API versions.
 *
 * Gated by configuration and off by default in production: the document is a
 * complete map of the attack surface, including which routes are unauthenticated.
 */
export function setupSwagger(app: INestApplication, config: AppConfigService): boolean {
  if (!config.swagger.enabled) return false;

  SwaggerModule.setup(
    config.swagger.path.replace(/^\//, ''),
    app,
    () => buildOpenApiDocument(app),
    {
      swaggerOptions: { persistAuthorization: true },
    },
  );

  return true;
}
