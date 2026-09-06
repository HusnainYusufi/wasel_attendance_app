export {
  API_ERROR_BODY_COMPONENT,
  API_ERROR_BODY_SCHEMA,
  buildContractSchemaRegistry,
  contractSchemaRegistry,
  schemaComponentName,
} from './contract-schemas.js';
export type { ContractSchemaRegistry, JsonSchema } from './contract-schemas.js';
export {
  ApiErrorResponses,
  ApiZodBody,
  ApiZodResponse,
  errorResponseRef,
  schemaRef,
} from './zod-api.decorators.js';
export { buildOpenApiDocument, setupSwagger } from './setup-swagger.js';
