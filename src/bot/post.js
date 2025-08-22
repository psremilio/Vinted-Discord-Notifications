import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { buildListingEmbed } from '../embeds.js';

export async function postArticles(newArticles, channelToSend) {
    const messages = newArticles.slice(0, 10).map(async (item) => {
        const origin = new URL(item.url).origin;
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setLabel('Details')
                .setEmoji('🗄️')
                .setStyle(ButtonStyle.Link)
                .setURL(`${origin}/items/${item.id}`),
            new ButtonBuilder()
                .setLabel('Message')
                .setEmoji('🪐')
                .setStyle(ButtonStyle.Link)
                .setURL(`${origin}/items/${item.id}/want_it/new?`)
        );

        const ts = item.photo?.high_resolution?.timestamp; // seconds
        const listing = {
            id: item.id,
            title: item.title,
            url: item.url,
            brand: item.brand_title,
            size: item.size_title,
            status: item.status,
            price: item.price?.amount,
            currency: item.price?.currency_code,
            price_eur: item.price?.converted_amount,
            // pass timestamp in milliseconds for embed time rendering
            createdAt: ts ? ts * 1000 : undefined,
            seller_name: item.user?.login,
            seller_avatar: item.user?.profile_picture?.url,
            image_url: item.photo?.url,
            country_code: item.user?.country_code,
            description: item.description,
        };

        return channelToSend.send({
            embeds: [buildListingEmbed(listing)],
            components: [row],
        });
    });
    await Promise.all(messages);
}