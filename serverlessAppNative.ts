import * as azure from "@pulumi/azure-native";
import { AccessTier } from "@pulumi/azure-native/storage/v20160101";
import { listWebAppHostKeys } from "@pulumi/azure-native/web";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";

export const ConsumptionSku = {
    tier: "Dynamic",
    name: "Y1"
};

const storageTier = {
    accessTier: AccessTier.Hot,
    kind: "StorageV2",
    sku: {
        name: "Standard_LRS",
    }
};

export interface ServerlessAppNativeImport {
    readonly storageAccountId: string;
    readonly appServicePlanId: string;
    readonly functionAppId: string;
}

export interface ServerlessAppNativeArgs {
    readonly namePrefix: string;
    readonly resourceGroupName: pulumi.Input<string>;
    readonly location: pulumi.Input<string>;
    readonly aiKey: pulumi.Input<string>;
    readonly appSettings?: pulumi.Input<{ [key: string]: string | pulumi.Input<string> }>;
    readonly environmentName?: string;
}

export class ServerlessAppNative extends pulumi.ComponentResource {
    readonly name: string;
    readonly identity: pulumi.Output<{ principalId: string; tenantId: string; }>;
    readonly connectionString: pulumi.Output<string>;

    constructor(name: string, args: ServerlessAppNativeArgs, options?: pulumi.ResourceOptions) {
        const componentName = `${args.namePrefix}praklabnative-${name}`;
        super("praklab:azure:ServerlessAppNative", componentName, {}, options);
        this.name = componentName;
        const parentArgs = { parent: this };

        const createStorage = (name: string) => new azure.storage.StorageAccount(
            name, {
                ...args,
                ...storageTier,
                accountName: name
            },
            parentArgs);

        const storage = createStorageName(componentName, this)
            .apply(name => createStorage(name));

        const storageAccountKeys = pulumi.all([args.resourceGroupName, storage.name])
            .apply(([resourceGroupName, accountName]) =>
                azure.storage.listStorageAccountKeys({ resourceGroupName, accountName }));
        const primaryStorageKey = storageAccountKeys.keys[0].value;

        const storageConnectionString = getStorageConnectionString(storage.name, primaryStorageKey);

        const { appSettings, aiKey } = args;
        const allAppSettings = this.createAppSettings(appSettings ? appSettings : {}, aiKey, storageConnectionString);

        const app = new azure.web.WebApp(
            componentName, {
                name: componentName,
                kind: "functionapp",
                resourceGroupName: args.resourceGroupName,
                location: args.location,
                serverFarmId: this.createAppServicePlan(componentName, args),
                clientAffinityEnabled: false,
                httpsOnly: true,
                identity: {
                    type: "SystemAssigned"
                },
                siteConfig: {
                    appSettings: allAppSettings,
                    http20Enabled: true,
                    webSocketsEnabled: false,
                    cors: {
                        allowedOrigins: ["*"]
                    }
                }
            },
            {
                ...parentArgs,
            });

        const masterKey = pulumi.all([app.name, app.resourceGroup])
            .apply(([name, resourceGroupName]) => listWebAppHostKeys({name, resourceGroupName})).masterKey;
        this.connectionString = pulumi.all([app.defaultHostName, masterKey])
            .apply(([hostname, masterKey]) =>
                create(`https://${hostname}/api`, masterKey));

        this.identity = pulumi.all([app.identity])
            .apply(([i]) => i === undefined ? {principalId: "", tenantId: ""} : i);
    }

    private createAppServicePlan(componentName: string,
                                 args: ServerlessAppNativeArgs):
                                 pulumi.Output<string> {
        const planName = `${componentName}-plan`;
        const plan = new azure.web.AppServicePlan(
            planName, {
                ...args,
                name: planName,
                kind: "functionapp",
                sku: ConsumptionSku
            });

        return plan.id;
    }

    private createAppSettings(appSettings: pulumi.Input<{ [key: string]: string | pulumi.Input<string> }>,
                              appInsightsKey: pulumi.Input<string>,
                              storageConnectionString: pulumi.Input<string>,
                              workerRuntime: string = "dotnet",
                              runFromPackage: number = 1) {
        return pulumi.all([appSettings, appInsightsKey, storageConnectionString])
            .apply(([appSettings, aiKey, storageConnectionString]) => {
                const newSettings = {
                    [SettingName.AppService.InstrumentationKey]: aiKey,
                    [SettingName.AppService.WorkerRuntime]: workerRuntime,
                    [SettingName.AppService.RunFromPackage]: runFromPackage.toString(),
                    [SettingName.AppService.ScmBuildDuringDeployment]: "false",
                    [SettingName.AppService.AzureWebJobsStorage]: storageConnectionString,
                    [SettingName.AppService.FunctionsExtensionVersion]: "~3",
                    ...appSettings
                };
                return this.outputAppSettings(newSettings);
            });
    }

    private outputAppSettings(appSettings: { [key: string]: string | pulumi.Input<string> }) {
        const inputs: pulumi.Input<azure.types.input.web.NameValuePairArgs>[] = [];
        const notInputs: { [key: string]: string } = {};
        for (const key in appSettings) {
            if (Object.prototype.hasOwnProperty.call(appSettings, key)) {
                const value = appSettings[key] as pulumi.Input<string>;
                if (value) {
                    inputs.push(pulumi.output(value)
                        .apply(v => { return {
                            name: key,
                            value: v
                        };
                    }));
                } else {
                    notInputs[key] = appSettings[key] as string;
                }
            }
        }
        return inputs;
    }
}

export const SettingName = {
    AppService: {
        RunFromPackage: "WEBSITE_RUN_FROM_PACKAGE",
        WorkerRuntime: "FUNCTIONS_WORKER_RUNTIME",
        ScmBuildDuringDeployment: "SCM_DO_BUILD_DURING_DEPLOYMENT",
        AzureWebJobsStorage: "AzureWebJobsStorage",
        FunctionsExtensionVersion: "FUNCTIONS_EXTENSION_VERSION",
        InstrumentationKey: "APPINSIGHTS_INSTRUMENTATIONKEY"
    },
}

export function create(endpoint: string, apiKey?: string){
    return `Endpoint=${endpoint};ApiKey=${apiKey}`
}

export function getStorageConnectionString(accountName: pulumi.Input<string>, accountKey: pulumi.Input<string>) {
    return pulumi.interpolate`DefaultEndpointsProtocol=https;AccountName=${accountName};AccountKey=${accountKey};EndpointSuffix=core.windows.net`;
}

export function createStorageName(name: string, parent: pulumi.Resource) {
    const newName = normalizeStorageName(name);
    if (newName.length < 25) {
        return pulumi.output(newName);
    }

    const randomOptions = {
        length: 4,
        lower: true,
        upper: false,
        number: true,
        special: false
    };
    return new random.RandomString(name, randomOptions, { parent }).result
        .apply(r => newName.substring(0, 20) + r);
}

export function normalizeStorageName(name: string) {
    return name.replace(/-/g, "");
}
