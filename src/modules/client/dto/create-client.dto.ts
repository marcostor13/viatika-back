import { IsString } from "class-validator";

import { IsNotEmpty } from "class-validator";

export class CreateClientDto {
    @IsNotEmpty()
    @IsString()
    comercialName: string;

    @IsString()
    businessName: string;

    @IsString()
    businessId: string; //ruc

    @IsString()
    address: string;

    @IsString()
    phone: string;

    @IsString()
    email: string;

    @IsString()
    logo: string;
}
