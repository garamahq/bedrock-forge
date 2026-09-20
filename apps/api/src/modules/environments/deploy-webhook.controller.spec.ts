import { Test } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { DeployWebhookController } from "./deploy-webhook.controller";
import { EnvironmentsService } from "./environments.service";

describe("DeployWebhookController", () => {
  let controller: DeployWebhookController;
  let svcMock: { triggerDeployWebhook: jest.Mock };

  beforeEach(async () => {
    svcMock = {
      triggerDeployWebhook: jest.fn().mockResolvedValue({ status: "deployed" }),
    };

    const module = await Test.createTestingModule({
      controllers: [DeployWebhookController],
      providers: [{ provide: EnvironmentsService, useValue: svcMock }],
    }).compile();

    controller = module.get(DeployWebhookController);
  });

  it("calls triggerDeployWebhook with query token and body", async () => {
    const req = { body: { ref: "refs/heads/main", after: "abc" } } as any;

    const res = await controller.handleDeployWebhook(
      1,
      req,
      "token-123",
      undefined,
      undefined,
      "push",
    );

    expect(res).toEqual({ status: "deployed" });
    expect(svcMock.triggerDeployWebhook).toHaveBeenCalledWith(1, {
      token: "token-123",
      signature: undefined,
      event: "push",
      body: req.body,
    });
  });

  it("calls triggerDeployWebhook with header token and signature", async () => {
    const req = { body: {} } as any;

    await controller.handleDeployWebhook(
      2,
      req,
      undefined,
      "header-token",
      "sha256=abcdef",
      "ping",
    );

    expect(svcMock.triggerDeployWebhook).toHaveBeenCalledWith(2, {
      token: "header-token",
      signature: "sha256=abcdef",
      event: "ping",
      body: req.body,
    });
  });

  it("throws BadRequestException when neither token nor signature is present", async () => {
    const req = { body: {} } as any;

    await expect(
      controller.handleDeployWebhook(
        3,
        req,
        undefined,
        undefined,
        undefined,
        "push",
      ),
    ).rejects.toThrow(BadRequestException);
  });
});
