import _ from 'lodash'
import humps from 'humps'
import Logger from '@ubverse/slw'
import { Lambda, InvocationType } from '@aws-sdk/client-lambda'
import { PartialDeep, Jsonifiable } from 'type-fest'

import { toStringHash } from './utils'

import {
  IAPIGatewayPayloadParams,
  IAPIGatewayPayloadWithRetry,
  IAPIGatewayResponse,
  ILambdaFunctionConstructor,
  ILambdaResponse,
  InvokeFunction,
  Nullable,
  WaitedInvokeResponse
} from './types'

export {
  InvocationType,
  IAPIGatewayPayloadWithRetry,
  IAPIGatewayResponse,
  ILambdaFunctionConstructor,
  ILambdaResponse,
  WaitedInvokeResponse
}

export default class LambdaFunction {
  private readonly lambdaName: string
  private readonly client: Lambda
  private readonly logger: Logger

  public constructor (params: ILambdaFunctionConstructor) {
    const client = new Lambda({ region: params.region })
    Object.assign(this, { client, ...params })
  }

  private async attempt<T>(
    retry: IAPIGatewayPayloadWithRetry['retry'],
    invokeFunction: InvokeFunction<T>
  ): WaitedInvokeResponse<T> {
    let { attempts, delay } = retry
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

  protected async invoke<T = any>(payload: Jsonifiable, invocationType: InvocationType): Promise<Nullable<T>> {
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

  private makeAPIGatewayPayload (params: PartialDeep<IAPIGatewayPayloadParams>): Jsonifiable {
    const httpMethod = params.method ?? 'GET'

    /* prettier-ignore */
    const path = params.resource === undefined
      ? '/'
      : params.resource.startsWith('/')
        ? params.resource
        : '/' + params.resource

    const isBase64Encoded = params.body?.isBinary ?? false
    const content = params.body?.content ?? null

    if (isBase64Encoded && !(content instanceof Buffer)) {
      throw new Error('body.content must be a Buffer when body.isBinary is true')
    }

    /* prettier-ignore */
    const body: Nullable<string> = content === null
      ? null
      : isBase64Encoded
        ? (content as Buffer).toString('base64')
        : JSON.stringify(content)

    return {
      path,
      httpMethod,
      body,
      isBase64Encoded,
      headers: Object.assign({ 'Content-Type': 'application/json' }, toStringHash(params.headers ?? {})),
      queryStringParameters: toStringHash(params.queryString ?? {}),
      resource: '/{proxy+}',
      pathParameters: { proxy: path },
      stageVariables: {},
      requestContext: {
        httpMethod,
        resourcePath: '/{proxy+}',
        protocol: 'HTTP/1.1'
      }
    }
  }

  protected async apiGatewayInvoke<T>(params: PartialDeep<IAPIGatewayPayloadWithRetry>): WaitedInvokeResponse<T> {
    const { attempts = 5, delay = 4 } = params.retry ?? {}
    const payload = this.makeAPIGatewayPayload(_.omit(params, ['retry']))

    return await this.attempt({ attempts, delay }, async (): Promise<ILambdaResponse> => {
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
