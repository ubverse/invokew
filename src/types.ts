import { Jsonifiable } from 'type-fest'
import Logger from '@ubverse/slw'

export type Nullable<T> = T | null

export type HttpMethods = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'OPTIONS'

export interface IHash<T = any> {
  [key: string]: T
}

export type LegalHttpHash = IHash<string | number>

/* ---------------------------------------------------------------------------- */

export interface IAPIGatewayPayloadParams {
  method: HttpMethods
  resource: string
  queryString: LegalHttpHash
  headers: LegalHttpHash
  body: {
    content: Jsonifiable | Buffer
    isBinary: boolean
  }
}

export interface IAPIGatewayPayloadWithRetry extends IAPIGatewayPayloadParams {
  retry: {
    attempts: number
    delay: number
  }
}

export interface IAPIGatewayResponse {
  statusCode: number
  body: string
  headers: IHash<string>
}

/* ---------------------------------------------------------------------------- */

export interface ILambdaFunctionConstructor {
  lambdaName: string
  region: string
  logger: Logger
}

export interface ILambdaResponse<T = any> {
  hasError: boolean
  content: T
}

export type InvokeFunction<T> = () => Promise<ILambdaResponse<T>>

export type WaitedInvokeResponse<T> = Promise<ILambdaResponse<Nullable<T>>>
