import { DockerImage, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as apig from 'aws-cdk-lib/aws-apigateway';
import * as appsync from 'aws-cdk-lib/aws-appsync';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import { IRole } from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaDestinations from 'aws-cdk-lib/aws-lambda-destinations';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { IBucket } from 'aws-cdk-lib/aws-s3';
import * as s3Deployment from 'aws-cdk-lib/aws-s3-deployment';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { CodeFirstSchema, Directive, GraphqlType, InputType, ObjectType, ResolvableField } from 'awscdk-appsync-utils';
import { NagSuppressions } from 'cdk-nag';
import { ServerlessClamscan } from 'cdk-serverless-clamscan';
import { StandardLambdaPythonFunction } from './standard-lambda-python-function';

import { Construct } from 'constructs';

export interface ModelsManagerProps {
  adminGroupRole: IRole;
  operatorGroupRole: IRole;
  authenticatedUserRole: IRole;
  logsBucket: IBucket;
  appsyncApi: {
    schema: CodeFirstSchema;
    api: appsync.IGraphqlApi;
    noneDataSource: appsync.NoneDataSource;
  };
  lambdaConfig: {
    runtime: lambda.Runtime;
    architecture: lambda.Architecture;
    bundlingImage: DockerImage;
    layersConfig: {
      powerToolsLogLevel: string;
      helperFunctionsLayer: lambda.ILayerVersion;
      powerToolsLayer: lambda.ILayerVersion;
    };
  };
}

export class ModelsManager extends Construct {
  public readonly modelsBucket: s3.Bucket;
  public readonly infectedBucket: s3.Bucket;
  public readonly apiCarsUploadResource: apig.Resource;

  constructor(scope: Construct, id: string, props: ModelsManagerProps) {
    super(scope, id);

    const stack = Stack.of(this);

    // Models S3 bucket
    const modelsBucket = new s3.Bucket(this, 'models_bucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      serverAccessLogsBucket: props.logsBucket,
      serverAccessLogsPrefix: 'access-logs/models_bucket/',
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      autoDeleteObjects: true,
      removalPolicy: RemovalPolicy.DESTROY,
      lifecycleRules: [
        { expiration: Duration.days(15), tagFilters: { lifecycle: 'true' } },
        { abortIncompleteMultipartUploadAfter: Duration.days(1) },
      ],
    });
    this.modelsBucket = modelsBucket;

    modelsBucket.policy!.document.addStatements(
      new iam.PolicyStatement({
        sid: 'AllowSSLRequestsOnly',
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ['s3:*'],
        resources: [modelsBucket.bucketArn, modelsBucket.bucketArn + '/*'],
        conditions: { NumericLessThan: { 's3:TlsVersion': '1.2' } },
      })
    );

    const infectedBucket = new s3.Bucket(this, 'infected_bucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      serverAccessLogsBucket: props.logsBucket,
      serverAccessLogsPrefix: 'access-logs/infected_bucket/',
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      autoDeleteObjects: true,
      removalPolicy: RemovalPolicy.DESTROY,
      lifecycleRules: [{ expiration: Duration.days(1) }, { abortIncompleteMultipartUploadAfter: Duration.days(1) }],
    });

    this.infectedBucket = infectedBucket;
    infectedBucket.policy!.document.addStatements(
      new iam.PolicyStatement({
        sid: 'AllowSSLRequestsOnly',
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ['s3:*'],
        resources: [infectedBucket.bucketArn, infectedBucket.bucketArn + '/*'],
        conditions: { NumericLessThan: { 's3:TlsVersion': '1.2' } },
      })
    );

    // Models table, used by deleteInfectedFilesFunction and also models_manager
    const modelsTable = new dynamodb.Table(this, 'ModelsTable', {
      partitionKey: {
        name: 'modelId',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      stream: dynamodb.StreamViewType.NEW_IMAGE,
      removalPolicy: RemovalPolicy.DESTROY,
      pointInTimeRecovery: true,
    });

    modelsTable.addGlobalSecondaryIndex({
      indexName: 'racerNameIndex',
      partitionKey: {
        name: 'racerName',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'modelId',
        type: dynamodb.AttributeType.STRING,
      },
      nonKeyAttributes: ['modelKey', 'modelFilename'],
      projectionType: dynamodb.ProjectionType.INCLUDE,
    });

    const deleteInfectedFilesFunction = new StandardLambdaPythonFunction(this, 'deleteInfectedFilesFunction', {
      entry: 'lib/lambdas/delete_infected_files_function/',
      index: 'index.py',
      handler: 'lambda_handler',
      timeout: Duration.minutes(1),
      runtime: props.lambdaConfig.runtime,
      memorySize: 256,
      architecture: props.lambdaConfig.architecture,
      environment: {
        DDB_TABLE: modelsTable.tableName,
        MODELS_S3_BUCKET: modelsBucket.bucketName,
        INFECTED_S3_BUCKET: infectedBucket.bucketName,
        POWERTOOLS_SERVICE_NAME: 'delete_infected_files',
        LOG_LEVEL: props.lambdaConfig.layersConfig.powerToolsLogLevel,
      },
      bundling: {
        image: props.lambdaConfig.bundlingImage,
      },
      layers: [props.lambdaConfig.layersConfig.helperFunctionsLayer, props.lambdaConfig.layersConfig.powerToolsLayer],
    });

    // Bucket and DynamoDB permissions
    modelsBucket.grantReadWrite(deleteInfectedFilesFunction, '*');
    infectedBucket.grantReadWrite(deleteInfectedFilesFunction, '*');
    modelsTable.grantReadWriteData(deleteInfectedFilesFunction);

    // Add clam av scan to S3 uploads bucket
    const antiVirusScan = new ServerlessClamscan(this, 'ClamScan', {
      buckets: [modelsBucket],
      onResult: new lambdaDestinations.LambdaDestination(deleteInfectedFilesFunction),
      onError: new lambdaDestinations.LambdaDestination(deleteInfectedFilesFunction),
      defsBucketAccessLogsConfig: {
        logsBucket: props.logsBucket,
        logsPrefix: 'access-logs/serverless-clam-scan/',
      },
    });

    // Quarantine Models Function
    const quarantinedModelsHandler = new StandardLambdaPythonFunction(this, 'quarantinedModelsHandler', {
      entry: 'lib/lambdas/get_quarantined_models_function/',
      index: 'index.py',
      handler: 'lambda_handler',
      timeout: Duration.minutes(1),
      runtime: props.lambdaConfig.runtime,
      memorySize: 128,
      architecture: props.lambdaConfig.architecture,
      environment: {
        infected_bucket: infectedBucket.bucketName,
        POWERTOOLS_SERVICE_NAME: 'get_quarantined_models',
        LOG_LEVEL: props.lambdaConfig.layersConfig.powerToolsLogLevel,
      },
      bundling: {
        image: props.lambdaConfig.bundlingImage,
      },
      layers: [props.lambdaConfig.layersConfig.helperFunctionsLayer, props.lambdaConfig.layersConfig.powerToolsLayer],
    });

    // permissions for s3 bucket read
    infectedBucket.grantRead(quarantinedModelsHandler, 'private/*');

    // upload_model_to_car_function
    const uploadModelToCarFunctionLambda = new StandardLambdaPythonFunction(this, 'uploadModelToCarFunctionLambda', {
      entry: 'lib/lambdas/upload_model_to_car_function/',
      index: 'index.py',
      handler: 'lambda_handler',
      timeout: Duration.minutes(1),
      runtime: props.lambdaConfig.runtime,
      memorySize: 128,
      architecture: props.lambdaConfig.architecture,
      environment: {
        MODELS_S3_BUCKET: modelsBucket.bucketName,
        POWERTOOLS_SERVICE_NAME: 'upload_model_to_car',
        LOG_LEVEL: props.lambdaConfig.layersConfig.powerToolsLogLevel,
      },
      bundling: {
        image: props.lambdaConfig.bundlingImage,
      },
      layers: [props.lambdaConfig.layersConfig.helperFunctionsLayer, props.lambdaConfig.layersConfig.powerToolsLayer],
    });
    uploadModelToCarFunctionLambda.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['ssm:GetCommandInvocation', 'ssm:SendCommand'],
        resources: ['*'],
      })
    );

    // upload_model_to_car_function
    const uploadModelToCarStatusLambda = new StandardLambdaPythonFunction(this, 'uploadModelToCarStatusLambda', {
      entry: 'lib/lambdas/upload_model_to_car_status_function/',
      index: 'index.py',
      handler: 'lambda_handler',
      timeout: Duration.minutes(1),
      runtime: props.lambdaConfig.runtime,
      memorySize: 128,
      architecture: props.lambdaConfig.architecture,
      environment: {
        POWERTOOLS_SERVICE_NAME: 'upload_model_to_car_status',
        LOG_LEVEL: props.lambdaConfig.layersConfig.powerToolsLogLevel,
      },
      bundling: {
        image: props.lambdaConfig.bundlingImage,
      },
      layers: [props.lambdaConfig.layersConfig.helperFunctionsLayer, props.lambdaConfig.layersConfig.powerToolsLayer],
    });

    uploadModelToCarStatusLambda.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['ssm:GetCommandInvocation'],
        resources: ['*'],
      })
    );
    // permissions for s3 bucket read
    modelsBucket.grantRead(uploadModelToCarFunctionLambda, 'private/*');

    modelsBucket.addCorsRule({
      allowedHeaders: ['*'],
      allowedMethods: [
        s3.HttpMethods.PUT,
        s3.HttpMethods.POST,
        s3.HttpMethods.GET,
        s3.HttpMethods.HEAD,
        s3.HttpMethods.DELETE,
      ],
      allowedOrigins: [
        '*',
        // "http://localhost:3000",
        // "https://" + distribution.distribution_domain_name
      ],
      exposedHeaders: ['x-amz-server-side-encryption', 'x-amz-request-id', 'x-amz-id-2', 'ETag'],
      maxAge: 3000,
    });

    const getModelsPolicy = new iam.Policy(this, 'modelApiPolicy', {
      statements: [
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['s3:get*'],
          resources: [`${modelsBucket.bucketArn}/*`],
        }),
      ],
    });
    getModelsPolicy.attachToRole(props.adminGroupRole);
    getModelsPolicy.attachToRole(props.operatorGroupRole);

    const modelsMd5Handler = new StandardLambdaPythonFunction(this, 'modelsMD5Function', {
      entry: 'lib/lambdas/models_md5/',
      description: 'Check MD5 on model files',
      index: 'index.py',
      handler: 'lambda_handler',
      timeout: Duration.minutes(1),
      runtime: props.lambdaConfig.runtime,
      memorySize: 128,
      architecture: props.lambdaConfig.architecture,
      environment: {
        DDB_TABLE: modelsTable.tableName,
        MODELS_S3_BUCKET: modelsBucket.bucketName,
        POWERTOOLS_SERVICE_NAME: 'md5_models',
        LOG_LEVEL: props.lambdaConfig.layersConfig.powerToolsLogLevel,
      },
      bundling: {
        image: props.lambdaConfig.bundlingImage,
      },
      layers: [props.lambdaConfig.layersConfig.helperFunctionsLayer, props.lambdaConfig.layersConfig.powerToolsLayer],
    });

    const deadLetterQueue = new sqs.Queue(this, 'deadLetterQueue', { enforceSSL: true });
    NagSuppressions.addResourceSuppressionsByPath(stack, `${deadLetterQueue.node.path}/Resource`, [
      {
        id: 'AwsSolutions-SQS3',
        reason: 'The SQS queue is used as a dead-letter queue (DLQ) for a DynamoEventSource',
      },
    ]);

    modelsMd5Handler.addEventSource(
      new lambdaEventSources.DynamoEventSource(modelsTable, {
        startingPosition: lambda.StartingPosition.TRIM_HORIZON,
        batchSize: 1,
        bisectBatchOnError: true,
        onFailure: new lambdaEventSources.SqsDlq(deadLetterQueue),
        retryAttempts: 5,
        filters: [
          lambda.FilterCriteria.filter({
            eventName: lambda.FilterRule.isEqual('INSERT'),
          }),
        ],
      })
    );

    // loged in user can only read/write their own bucket
    const ownModelsPolicy = new iam.Policy(this, 'userAccessToOwnModels', {
      statements: [
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:PutObjectTagging'],
          resources: [
            modelsBucket.bucketArn + '/private/${cognito-identity.amazonaws.com:sub}',
            modelsBucket.bucketArn + '/private/${cognito-identity.amazonaws.com:sub}/*',
          ],
        }),
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['s3:ListBucket'],
          resources: [modelsBucket.bucketArn],
          conditions: {
            StringLike: {
              's3:prefix': ['private/${cognito-identity.amazonaws.com:sub}/*'],
            },
          },
        }),
      ],
    });
    ownModelsPolicy.attachToRole(props.authenticatedUserRole);
    ownModelsPolicy.attachToRole(props.adminGroupRole);
    ownModelsPolicy.attachToRole(props.operatorGroupRole);

    // Permissions for DynamoDB read / write
    modelsTable.grantReadWriteData(modelsMd5Handler);
    // Permissions for DynamoDB stream read
    modelsTable.grantStreamRead(modelsMd5Handler);

    // Permissions for s3 bucket read / write
    modelsBucket.grantReadWrite(modelsMd5Handler, 'private/*');

    /* Deploy Default DeepRacer models. FOr the models to be properly index this needs to run
        after the antivirus deployment and lambda putting the models info into the models DDB table */
    const defaultModelsDeployment = new s3Deployment.BucketDeployment(this, 'ModelsDeploy', {
      sources: [s3Deployment.Source.asset('./lib/default_models')],
      destinationBucket: modelsBucket,
      destinationKeyPrefix: `private/${stack.region}:00000000-0000-0000-0000-000000000000/default/models/`,
      retainOnDelete: false,
      memoryLimit: 512,
    });
    defaultModelsDeployment.node.addDependency(antiVirusScan);
    defaultModelsDeployment.node.addDependency(deleteInfectedFilesFunction);

    const modelsHandler = new StandardLambdaPythonFunction(this, 'modelsFunction', {
      entry: 'lib/lambdas/models_api/',
      description: 'Models resolver',
      index: 'index.py',
      handler: 'lambda_handler',
      timeout: Duration.minutes(1),
      runtime: props.lambdaConfig.runtime,
      memorySize: 128,
      architecture: props.lambdaConfig.architecture,
      environment: {
        DDB_TABLE: modelsTable.tableName,
        POWERTOOLS_SERVICE_NAME: 'models resolver',
        LOG_LEVEL: props.lambdaConfig.layersConfig.powerToolsLogLevel,
        MODELS_S3_BUCKET: modelsBucket.bucketName,
      },
      bundling: {
        image: props.lambdaConfig.bundlingImage,
      },
      layers: [props.lambdaConfig.layersConfig.helperFunctionsLayer, props.lambdaConfig.layersConfig.powerToolsLayer],
    });

    modelsTable.grantReadWriteData(modelsHandler);
    modelsBucket.grantRead(modelsHandler, 'private/*');

    // Define the data source for the API
    const modelsDataSource = props.appsyncApi.api.addLambdaDataSource('ModelsDataSource', modelsHandler);

    // GraphQL API
    const modelObjectType = new ObjectType('Models', {
      definition: {
        modelId: GraphqlType.id(),
        modelKey: GraphqlType.string(),
        racerName: GraphqlType.string(),
        racerIdentityId: GraphqlType.string(),
        modelFilename: GraphqlType.string(),
        uploadedDateTime: GraphqlType.awsDateTime(),
        md5DateTime: GraphqlType.awsDateTime(),
        modelMD5: GraphqlType.string(),
        modelMetadataMD5: GraphqlType.string(),
      },
    });

    props.appsyncApi.schema.addType(modelObjectType);

    props.appsyncApi.schema.addQuery(
      'getAllModels',
      new ResolvableField({
        returnType: modelObjectType.attribute({ isList: true }),
        dataSource: modelsDataSource,
        directives: [Directive.cognito('admin', 'operator')],
      })
    );

    props.appsyncApi.schema.addQuery(
      'getModelsForUser',
      new ResolvableField({
        args: {
          racerName: GraphqlType.string({ isRequired: true }),
        },
        returnType: modelObjectType.attribute({ isList: true }),
        dataSource: modelsDataSource,
        directives: [Directive.cognito('admin', 'operator')],
      })
    );

    const quarantinedModelsDataSource = props.appsyncApi.api.addLambdaDataSource(
      'quarantinedModelsDataSource',
      quarantinedModelsHandler
    );

    props.appsyncApi.schema.addQuery(
      'getQuarantinedModels',
      new ResolvableField({
        returnType: modelObjectType.attribute({ isList: true }),
        dataSource: quarantinedModelsDataSource,
        directives: [Directive.cognito('admin', 'operator')],
      })
    );

    props.appsyncApi.schema.addMutation(
      'addModel',
      new ResolvableField({
        args: {
          modelKey: GraphqlType.string({ isRequired: true }),
          racerName: GraphqlType.string({ isRequired: true }),
          racerIdentityId: GraphqlType.string({ isRequired: true }),
        },
        returnType: modelObjectType.attribute(),
        dataSource: modelsDataSource,
      })
    );
    props.appsyncApi.schema.addSubscription(
      'addedModel',
      new ResolvableField({
        returnType: modelObjectType.attribute(),
        dataSource: props.appsyncApi.noneDataSource,
        requestMappingTemplate: appsync.MappingTemplate.fromString(
          `{
                        "version": "2017-02-28",
                    "payload": $util.toJson($context.arguments.entry)
                    }`
        ),
        responseMappingTemplate: appsync.MappingTemplate.fromString('$util.toJson($context.result)'),
        directives: [Directive.subscribe('addModel')],
      })
    );

    props.appsyncApi.schema.addMutation(
      'updateModel',
      new ResolvableField({
        args: {
          modelId: GraphqlType.string({ isRequired: true }),
          modelKey: GraphqlType.string({ isRequired: true }),
          modelFilename: GraphqlType.string(),
          uploadedDateTime: GraphqlType.string(),
          md5DateTime: GraphqlType.string(),
          modelMD5: GraphqlType.string(),
          modelMetadataMD5: GraphqlType.string(),
        },
        returnType: modelObjectType.attribute(),
        dataSource: modelsDataSource,
      })
    );

    props.appsyncApi.schema.addSubscription(
      'updatedModel',
      new ResolvableField({
        returnType: modelObjectType.attribute(),
        dataSource: props.appsyncApi.noneDataSource,
        requestMappingTemplate: appsync.MappingTemplate.fromString(
          `{
                        "version": "2017-02-28",
                        "payload": $util.toJson($context.arguments.entry)
                    }`
        ),
        responseMappingTemplate: appsync.MappingTemplate.fromString('$util.toJson($context.result)'),
        directives: [Directive.subscribe('updateModel')],
      })
    );

    // GraphQL upload model to car
    const uploadModelToCarInputType = new InputType('UploadModelToCarInput', {
      definition: {
        carInstanceId: GraphqlType.string(),
        modelKey: GraphqlType.string(),
      },
    });

    props.appsyncApi.schema.addType(uploadModelToCarInputType);

    const uploadModelToCarType = new ObjectType('UploadModelToCar', {
      definition: {
        carInstanceId: GraphqlType.string(),
        modelKey: GraphqlType.string(),
        ssmCommandId: GraphqlType.string(),
      },
    });

    props.appsyncApi.schema.addType(uploadModelToCarType);

    const uploadModelToCarStatusType = new ObjectType('UploadModelToCarStatus', {
      definition: {
        carInstanceId: GraphqlType.string(),
        ssmCommandId: GraphqlType.string(),
        ssmCommandStatus: GraphqlType.string(),
      },
    });

    props.appsyncApi.schema.addType(uploadModelToCarStatusType);

    const uploadModelToCarStatusDataSource = props.appsyncApi.api.addLambdaDataSource(
      'uploadModelToCarStatusDataSource',
      uploadModelToCarStatusLambda
    );

    const uploadModelToCarDataSource = props.appsyncApi.api.addLambdaDataSource(
      'uploadModelToCarDataSource',
      uploadModelToCarFunctionLambda
    );

    props.appsyncApi.schema.addMutation(
      'uploadModelToCar',
      new ResolvableField({
        args: {
          entry: uploadModelToCarInputType.attribute({ isRequired: true }),
        },
        returnType: uploadModelToCarType.attribute(),
        dataSource: uploadModelToCarDataSource,
        directives: [Directive.iam(), Directive.cognito('admin', 'operator')],
      })
    );

    props.appsyncApi.schema.addQuery(
      'getUploadModelToCarStatus',
      new ResolvableField({
        args: {
          carInstanceId: GraphqlType.string({ isRequired: true }),
          ssmCommandId: GraphqlType.string({ isRequired: true }),
        },
        returnType: uploadModelToCarStatusType.attribute(),
        dataSource: uploadModelToCarStatusDataSource,
        directives: [Directive.iam(), Directive.cognito('admin', 'operator')],
      })
    );
  }
}
