import humps from 'humps'
import { Lambda, InvocationType } from '@aws-sdk/client-lambda'
import Logger from '@ubverse/slw'

type Nullable<T> = T | null

interface IHash<T = any> {
  [key: string]: T
}

export interface ILambdaResponse<T = any> {
  hasError: boolean
  content: T
}

export interface IAPIGatewayPayloadParams {
  method: string
  resource: string
  body?: string
  queryString?: IHash<string | number>
}

export interface ILambdaInvokeRetry {
  retry: {
    attempts: number
    delay: number
  }
}

export interface IAPIGatewayPayloadWithRetry extends IAPIGatewayPayloadParams, Partial<ILambdaInvokeRetry> {}

export interface IAPIGatewayResponse {
  statusCode: number
  body: string
  headers: IHash<string>
}

export interface ILambdaFunctionConstructor {
  lambdaName: string
  region: string
  logger: Logger
}

export type InvokeFunction<T> = () => Promise<ILambdaResponse<T>>

export type WaitedInvokeResponse<T> = Promise<ILambdaResponse<Nullable<T>>>

export { InvocationType }

export default class LambdaFunction {
  private readonly lambdaName: string
  private readonly client: Lambda
  private readonly logger: Logger

  public constructor (params: ILambdaFunctionConstructor) {
    const client = new Lambda({ region: params.region })
    Object.assign(this, { client, ...params })
  }

  protected makeAPIGatewayPayload (params: IAPIGatewayPayloadParams): IHash {
    const { method: httpMethod, resource: path, body, queryString } = params

    // convert all query string values to strings
    const queryStringParameters = Object.fromEntries(
      Object.entries(queryString ?? {}).map(([key, value]) => [key, value.toString()])
    )

    return {
      path,
      httpMethod,
      queryStringParameters,
      body: body ?? null,
      isBase64Encoded: Boolean(body),
      resource: '/{proxy+}',
      headers: { 'Content-Type': 'application/json' },
      pathParameters: { proxy: path },
      stageVariables: {},
      requestContext: {
        httpMethod,
        resourcePath: '/{proxy+}',
        protocol: 'HTTP/1.1'
      }
    }
  }

  private async attempt<T>(params: Partial<ILambdaInvokeRetry>, invokeFunction: InvokeFunction<T>): WaitedInvokeResponse<T> {
    let { attempts = 5, delay = 4 } = params.retry ?? {}
    let res: ILambdaResponse<Nullable<T>> = { hasError: false, content: null }

    for (let i = 0; i < attempts; i++) {
      if (i > 0) {
        this.logger.info(`retrying attempt (${i}/${attempts - 1})`)
      }

      res = await invokeFunction()

      /* the last attempt should not be followed by a wait time; on success, return immediately */
      if (i === attempts - 1 || !res.hasError) {
        break
      }

      this.logger.error('failed to invoke lambda function', res.content ?? {})
      this.logger.info(`trying again in ${delay} seconds`)

      await new Promise((resolve) => setTimeout(resolve, delay * 1000))

      /* exponentially increase the wait time */
      delay *= 2
    }

    return res
  }

  protected async invoke<T = any>(payload: any, invocationType: InvocationType): Promise<Nullable<T>> {
    const response = await this.client.invoke({
      FunctionName: this.lambdaName,
      InvocationType: invocationType,
      LogType: 'None',
      Payload: Buffer.from(JSON.stringify(payload))
    })

    /* "event" invocations are fire-and-forget, meaning that the sdk will not wait for a response
       in other words: the response will always be empty */
    if (invocationType === InvocationType.Event) {
      return null
    }

    if (response.Payload === undefined || (Array.isArray(response.Payload) && response.Payload.length === 0)) {
      return null
    }

    return JSON.parse(new TextDecoder().decode(response.Payload))
  }

  protected async invokeWrapped<T>(params: IAPIGatewayPayloadWithRetry): WaitedInvokeResponse<T> {
    const { method, resource, body, queryString, retry } = params
    const payload = this.makeAPIGatewayPayload({ method, resource, body, queryString })

    return await this.attempt({ retry }, async (): Promise<ILambdaResponse> => {
      try {
        const res = await this.invoke<IAPIGatewayResponse>(payload, InvocationType.RequestResponse)

        return {
          hasError: false,
          content: humps.camelizeKeys<T>(JSON.parse(res?.body ?? 'null'))
        }
      } catch (e: any) {
        return {
          hasError: true,
          content: e
        }
      }
    })
  }
}
