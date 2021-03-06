import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";
import * as utils from "../utils/utils";

const config = new pulumi.Config();
const numOfAzs = parseInt(config.require("numOfAzs"));
const accountId = aws.getCallerIdentity({}).accountId;
const bucketName = config.get("bucketName");
const bastionAmi = config.require("bastionAmi");
const bastionInstanceType = config.require<aws.ec2.InstanceType>("bastionInstanceType");
const pubKey = config.require("pubKey");
export const vpcCIDR = config.require("vpcCIDR");
export const highAvailability = config.getBoolean("highAvailability");

/************** SUBNETS **************/
        
const publicSubnetArgs: awsx.ec2.VpcSubnetArgs = {
    name: 'publicSubnet',
    cidrMask: 20,
    type: 'public',
};

const privateSubnetArgs: awsx.ec2.VpcSubnetArgs = {
    name: 'privateSubnet',
    cidrMask: 20,
    type: 'private',
};

const isolatedSubnetArgs: awsx.ec2.VpcSubnetArgs = {
    name: 'isolatedSubnet',
    cidrMask: 20,
    type: 'isolated',
};

/************** VPC **************/
const vpcArguments: awsx.ec2.VpcArgs = {
    cidrBlock: vpcCIDR,
    numberOfAvailabilityZones: numOfAzs,
    numberOfNatGateways: numOfAzs,
    enableDnsHostnames: true,
    enableDnsSupport: true,
    tags: { 
        Name: "eks-cdm", 
        CreatedBy: `process.env.USER`
    },
    subnets: [ publicSubnetArgs, privateSubnetArgs, isolatedSubnetArgs ],
};

const vpc = new awsx.ec2.Vpc("eks-cdm", vpcArguments);
export const vpcid = vpc.id;
export const vpcPrivateSubnetsIds = vpc.privateSubnetIds;
export const vpcPublicSubnetsIds = vpc.publicSubnetIds;
export const vpcIsolatedSubnetsIds = vpc.isolatedSubnetIds;
export const vpcAllSubnets = vpc.privateSubnetIds.concat(vpc.publicSubnetIds).concat(vpc.isolatedSubnetIds);

const bastionSG = new aws.ec2.SecurityGroup("bastionSG", {
    ingress: [{ protocol: "tcp", fromPort: 22, toPort: 22, cidrBlocks: ["71.36.119.84/32"] }],
    egress: [{cidrBlocks: ["0.0.0.0/0"], fromPort: 0, toPort: 0, protocol: "-1"}],
    tags: {Name: "BastionSG"},
    vpcId: vpcid,
});
export const bastionSgId = bastionSG.id

/************** IAM **************/
// IAM clusterAdminRole with full access to all cluster resources
const clusterAdministratorRole = utils.createRole("clusterAdministratorRole", "root")
export const clusterAdministratorRoleID = clusterAdministratorRole.id;

/************** S3 BUCKET **************/
// initialize bucket variable
let bucket: aws.s3.Bucket;

// Create an S3 Bucket if bucket name supplied in stack config file.
if (bucketName !== undefined) {
    // create bucket
    bucket = new aws.s3.Bucket(bucketName, {
        bucket: bucketName,
        forceDestroy: true,
        versioning: {
            enabled: true
        }
    });

    //restrict bucket public access
    new aws.s3.BucketPublicAccessBlock("blockPublicAccess", {
        blockPublicAcls: true,
        blockPublicPolicy: true,
        restrictPublicBuckets: true,
        ignorePublicAcls: true,
        bucket: bucket.id,
    });
}

/************** Bastion Server **************/
const bastionKeyPair = new aws.ec2.KeyPair("bastionKeyPair", {
    publicKey: pubKey,
});


const bastion = new aws.ec2.Instance("BastionServer", {
    instanceType: bastionInstanceType,
    securityGroups: [bastionSgId],
    ami: bastionAmi,
    keyName: bastionKeyPair.keyName,
    associatePublicIpAddress: true, 
    subnetId: vpc.publicSubnetIds[0],
    tags: {Name: "Bastion"},
});
export const bastionPublicIp = bastion.publicIp;


export let extIngresstg80arn : any = undefined
export let extIngresstg443arn : any = undefined
if (highAvailability) //If highAvailability is False, it is assumed that the user will use type loadbalancer. 
{
    /************** Load Balancer **************/
    const nlb1 = new awsx.lb.NetworkLoadBalancer("ExtIngressLB", { 
        external: true,
        enableCrossZoneLoadBalancing: true,
        vpc: vpc, 
        subnets: vpc.publicSubnetIds,         
        });

    const extIngresstg80 = nlb1.createTargetGroup("ExtIngressLBTCP80", { port: 30080, targetType: "instance"});
    const listener1 = extIngresstg80.createListener("listener1", { port: 80});
    extIngresstg80arn = extIngresstg80.targetGroup.arn;

    const extIngresstg443 = nlb1.createTargetGroup("ExtIngressLBTCP443", { port: 30443, targetType: "instance"});
    const listener2 = extIngresstg443.createListener("listener2", { port: 443});
    extIngresstg443arn = extIngresstg443.targetGroup.arn;

}

