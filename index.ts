import * as azure from "@pulumi/azure";
import * as azurenative from "@pulumi/azure-native";
import * as resources from "@pulumi/azure-native/resources";
import { ServerlessAppNative } from "./serverlessAppNative";

// Create an Azure Resource Group
const resourceGroup = new resources.ResourceGroup("rg-praklab-f1");

//create storage
const componentName = "sa-praklab-112";
const serviceName = "posts";
const group = new azure.core.ResourceGroup(
    componentName,
    {
        name: componentName,
        location: "southeastasia",
        tags: { "service": serviceName }
    });

const groupOptions = { parent: group };
const protectedGroupOptions = {
    parent: group,
    protect: true
};

//create function
const appName = "f1";
const recommendationsAppSettings = {
    "test:appsetting:1": "1",
    "test:appsetting:2": "1",
};
const nativeApp = new ServerlessAppNative(
    appName, {
    resourceGroupName: resourceGroup.name,
    location: "eastus",
    namePrefix: "fn-",
    aiKey: "test2",
    appSettings: recommendationsAppSettings,
    environmentName: "dev",
},
    groupOptions);

//create keyvault with accesspolicy
const vault = new azurenative.keyvault.Vault("vault", {
    location: "westus",
    properties: {
        accessPolicies: [{
            objectId: nativeApp.identity.principalId,
            permissions: {
                certificates: [
                    "get"
                ]
            },
            tenantId: nativeApp.identity.tenantId,
        }],
        enabledForDeployment: true,
        enabledForDiskEncryption: true,
        enabledForTemplateDeployment: true,
        sku: {
            family: "A",
            name: "standard",
        },
        tenantId: "<hard coded value>",
    },
    resourceGroupName: resourceGroup.name,
    vaultName: "fn-prakvault3-333",
});


